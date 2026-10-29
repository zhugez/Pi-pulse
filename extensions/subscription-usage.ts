/**
 * Subscription usage extension.
 *
 * Shows usage for the active subscription-backed provider as a minimal
 * width-aware widget below the editor. Wide terminals show bars; narrow
 * terminals use percentages and wrap rather than dropping quota windows:
 *
 *   R: ░░░░░░ 4% ~4h · W: ██████ 97% ~8h · M: █████░░░ 62% ~20d
 *   Peak ~2h · R: ░░░░░░ 4% ~4h                  ← DeepSeek peak hours
 *   5h: ░░░░░░ 1% ~4h · W: ░░░░░░ 0% ~6d
 *   Off-Peak ~5h · $12.34                        ← DeepSeek API balance
 *
 * `/usage` shows the detailed readout for all providers;
 * `/usage toggle [bars|percent|off]` cycles bars → bare percentages →
 * hidden (or jumps straight to the given mode); the choice persists in
 * ~/.pi/agent/subscription-usage-prefs.json.
 *
 * `/usage refresh [active|<provider>|all]` force-refetches the active provider
 * by default; `all` explicitly checks every configured usage provider.
 *
 * Each window also shows a compact countdown (~) until it resets. OpenCode
 * reports `resetsAt` (ISO) per window; Codex reports `reset_at` (epoch s);
 * Antigravity reports `resetTime` (ISO) per bucket. DeepSeek bills on two UTC
 * peak windows, UTC weekdays only (01:00–04:00 and 06:00–10:00 UTC), rendered in
 * local time, and the DeepSeek API provider additionally shows the account
 * balance from `GET /user/balance`.
 *
 * Fetch strategy (adaptive, no spam):
 * - Fetch on session start, model switch, and right after an agent turn
 *   settles (agent_settled), gated by a 60s cooldown unless a usage window
 *   is about to flip.
 * - Idle scheduling is reset-aware: it wakes shortly after a usage window
 *   resets so fresh pools show up promptly, backs off exponentially
 *   (20s → 30min) on API failures, and jitters ±20% so timers don't sync
 *   across sessions.
 *
 * Built-in API keys resolve from env first, then auth.json. Opted-in codex-lb
 * providers use Pi's model registry for their own URL, credentials and headers.
 * The direct Codex endpoint requires a browser User-Agent to pass Cloudflare.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AccountStore, accountDisplayName } from "./codex-pool/store.ts";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createUsageCache } from "./subscription-usage/cache.ts";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import { CLIENT_ID, CLIENT_SECRET, TOKEN_URL } from "./antigravity/auth/oauth.ts";
import { ENDPOINT_FALLBACKS } from "./antigravity/client/client.ts";
import {
	asRecord,
	finiteNumber,
	normalizePercent,
	normalizeUsageData,
	type UsageBalance,
	type UsageData,
} from "./subscription-usage/data.ts";

const ipv4Dispatcher = new UndiciAgent({
	connect: {
		autoSelectFamily: false,
		family: 4,
	},
});

// Preserve the existing extension's exports for callers and tests.
export { normalizeUsageData, type UsageBalance, type UsageData } from "./subscription-usage/data.ts";

interface ApiKeyCredential {
	type: "api_key";
	key: string;
}

interface OAuthCredential {
	type: "oauth";
	access: string;
	refresh?: string;
	expires?: number;
}

type StoredCredential = ApiKeyCredential | OAuthCredential;

/**
 * Thrown when no usable credential (API key or OAuth token) exists for the
 * account. Kept distinct from real fetch failures so `/usage refresh` can
 * report a provider as unavailable instead of failed/retried.
 */
export class MissingCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MissingCredentialError";
	}
}

const AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");

function readStoredCredential(
	providerId: string,
	authPath = AUTH_PATH,
): StoredCredential | undefined {
	try {
		const raw = fs.readFileSync(authPath, "utf8");
		const data = JSON.parse(raw) as Record<string, StoredCredential>;
		return data?.[providerId];
	} catch {
		return undefined;
	}
}

const INTERVAL_MS = 5 * 60 * 1000; // idle refresh fallback
const COOLDOWN_MS = 60 * 1000; // min gap between real fetches (event pokes)
const MIN_FETCH_GAP_MS = 10_000; // absolute floor between API hits
const ERROR_BACKOFF_BASE_MS = 20_000; // first failed retry waits 20s…
const ERROR_BACKOFF_CAP_MS = 30 * 60 * 1000; // …capped at 30 min
const RESET_CATCH_DELAY_MS = 5_000; // refetch shortly after a window flips
const JITTER_RATIO = 0.2; // ±20%, avoid lockstep with other instances
const BAR_CELLS = 6;
const CACHE_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"subscription-usage-cache.json",
);
// Shared across extension instances, as the previous module-level cache was.
const diskCache = createUsageCache(CACHE_PATH);
const PREFS_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"subscription-usage-prefs.json",
);

/** Display style for usage windows: bar cells or bare percentages. */
export type UsageStyle = "bars" | "percent";

export const USAGE_STYLES: readonly UsageStyle[] = ["bars", "percent"];

/** Toggle states: both display styles plus fully hidden ("off"). */
export type UsageMode = UsageStyle | "off";

export const USAGE_MODES: readonly UsageMode[] = ["bars", "percent", "off"];

export function normalizeUsageStyle(value: unknown): UsageStyle | undefined {
	return typeof value === "string" && (USAGE_STYLES as string[]).includes(value)
		? (value as UsageStyle)
		: undefined;
}

export function normalizeUsageMode(value: unknown): UsageMode | undefined {
	return typeof value === "string" && (USAGE_MODES as string[]).includes(value)
		? (value as UsageMode)
		: undefined;
}

export interface UsagePrefs {
	mode: UsageMode;
	/** Explicit opt-in: never probe arbitrary OpenAI-compatible providers. */
	codexLbProviders?: string[];
}

/** Validate a parsed prefs file, falling back to defaults on anything odd. */
export function normalizePrefs(value: unknown): UsagePrefs {
	const record = asRecord(value);
	const codexLbProviders = Array.isArray(record?.codexLbProviders)
		? [...new Set(record.codexLbProviders.filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9_.-]+$/.test(id)))]
		: [];
	return {
		...(codexLbProviders.length ? { codexLbProviders } : {}),
		mode:
			normalizeUsageMode(record?.mode) ??
			// Legacy pref files wrote { style } before the cycle toggle existed.
			normalizeUsageStyle(record?.style) ??
			"bars",
	};
}

function loadPrefs(): UsagePrefs {
	try {
		return normalizePrefs(
			JSON.parse(fs.readFileSync(PREFS_PATH, "utf8")) as unknown,
		);
	} catch {
		return { mode: "bars" };
	}
}

async function savePrefs(prefs: UsagePrefs): Promise<void> {
	try {
		await fs.promises.mkdir(path.dirname(PREFS_PATH), { recursive: true });
		await fs.promises.writeFile(
			PREFS_PATH,
			`${JSON.stringify(prefs, null, 2)}\n`,
			"utf8",
		);
	} catch (error) {
		console.error("[subscription-usage] failed to save usage prefs:", error);
	}
}

interface ProviderCfg {
	id: string;
	fetchUsage: (signal?: AbortSignal, ctx?: StatusCtx) => Promise<UsageData>;
	sharedCache?: boolean;
	render: (
		data: UsageData,
		theme: { fg(color: string, text: string): string },
		modelId?: string,
		style?: UsageStyle,
	) => string;
}

/**
 * Result of one provider refresh: fresh data, reused cache, no credential
 * for the account (nothing was requested), or a real fetch failure.
 */
export type RefreshOutcome = "fetched" | "cached" | "skipped" | "failed";

export interface RefreshResult {
	id: string;
	outcome: RefreshOutcome;
	error?: string;
}

interface StatusCtx {
	model?: ExtensionContext["model"];
	modelRegistry?: ExtensionContext["modelRegistry"];
	ui: {
		setStatus(key: string, text: string | undefined): void;
		setWidget?: ExtensionContext["ui"]["setWidget"];
		theme: { fg(color: string, text: string): string };
	};
}

/** Per-provider scheduler state: timers, backoff counter, cached results. */
interface ProviderState {
	lastError?: string;
	lastFetch: number; // when we last successfully retrieved fresh data from API/cache
	lastAttempt: number; // when we last attempted a fetch
	lastText: string | undefined;
	lastData: UsageData | undefined; // last successful payload (reset times)
	failStreak: number; // consecutive failures → exponential backoff
	timer: ReturnType<typeof setTimeout> | undefined;
	timerDeadline?: number;
	inFlight: Promise<RefreshOutcome> | undefined;
	requestId: number;
	abortController?: AbortController;
}

export function cap(s: string): string {
	return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Compact remaining-time label for a reset deadline, e.g. "~4h", "~20d",
 * "~<1m" once the window is about to flip. Never shows negative times.
 */
export function resetLabel(resetMs: number, now = Date.now()): string {
	if (!Number.isFinite(resetMs) || !Number.isFinite(now)) return "~?";
	const remain = resetMs - now;
	if (remain <= 60_000) return "~<1m";
	const m = Math.floor(remain / 60_000);
	if (m < 60) return `~${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `~${h}h`;
	const d = Math.floor(h / 24);
	if (d < 30) return `~${d}d`;
	return `~${Math.floor(d / 7)}w`;
}

/** `YYYY-MM-DD HH:MM UTC` for an epoch timestamp; `unknown time` if invalid. */
function utcStamp(ms: number): string {
	if (!Number.isFinite(ms)) return "unknown time";
	try {
		return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
	} catch {
		return "unknown time";
	}
}

/** `HH:MM GMT+7` (if today) or `MM-DD HH:MM GMT+7` in Vietnam timezone for an epoch timestamp. */
function vnStamp(ms: number, now = Date.now()): string {
	if (!Number.isFinite(ms)) return "unknown time";
	try {
		const d = new Date(ms);
		const nowDate = new Date(now);
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Asia/Ho_Chi_Minh",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).formatToParts(d);
		const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
		const y = get("year");
		const m = get("month");
		const day = get("day");
		const h = get("hour");
		const min = get("minute");

		const nowParts = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Asia/Ho_Chi_Minh",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(nowDate);
		const nowGet = (type: string) => nowParts.find((p) => p.type === type)?.value ?? "";
		const nowY = nowGet("year");
		const nowM = nowGet("month");
		const nowDay = nowGet("day");

		if (y === nowY && m === nowM && day === nowDay) {
			return `${h}:${min} GMT+7`;
		}
		if (y === nowY) {
			return `${day}-${m} ${h}:${min} GMT+7`;
		}
		return `${day}-${m}-${y} ${h}:${min} GMT+7`;
	} catch {
		return utcStamp(ms);
	}
}

/** Compact Vietnam timestamp (`DD/MM HH:MM` or `HH:MM` if today) in `Asia/Ho_Chi_Minh`. */
function vnShortStamp(ms: number, now = Date.now()): string {
	if (!Number.isFinite(ms)) return "??:??";
	try {
		const fmt = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Asia/Ho_Chi_Minh",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
		const parts = fmt.formatToParts(new Date(ms));
		const nowParts = fmt.formatToParts(new Date(now));
		const get = (arr: Intl.DateTimeFormatPart[], t: string) =>
			arr.find((p) => p.type === t)?.value ?? "";
		const day = get(parts, "day");
		const m = get(parts, "month");
		const h = get(parts, "hour");
		const min = get(parts, "minute");
		const sameDay =
			get(parts, "year") === get(nowParts, "year") &&
			m === get(nowParts, "month") &&
			day === get(nowParts, "day");
		return sameDay ? `${h}:${min}` : `${day}/${m} ${h}:${min}`;
	} catch {
		return "??:??";
	}
}

// Catppuccin Mocha 24-bit TrueColor palette (https://catppuccin.com/palette/)
const CTP = {
	rosewater: "245;224;220", // #f5e0dc
	flamingo:  "242;205;205", // #f2cdcd
	pink:      "245;194;231", // #f5c2e7
	mauve:     "203;166;247", // #cba6f7
	red:       "243;139;168", // #f38ba8
	maroon:    "235;160;172", // #eba0ac
	peach:     "250;179;135", // #fab387
	yellow:    "249;226;175", // #f9e2af
	green:     "166;227;161", // #a6e3a1
	teal:      "148;226;213", // #94e2d5
	sky:       "137;220;235", // #89dceb
	sapphire:  "116;199;236", // #74c7ec
	blue:      "137;180;250", // #89b4fa
	lavender:  "180;190;254", // #b4befe
	text:      "205;214;244", // #cdd6f4
	subtext0:  "166;173;200", // #a6adc8
	overlay1:  "127;132;156", // #7f849c
	surface2:  "88;91;112",   // #585b70
} as const;

type CtpColor = keyof typeof CTP;

function ctp(color: CtpColor, text: string): string {
	return `\x1b[22;38;2;${CTP[color]}m${text}\x1b[39m`;
}

function isColorTheme(theme?: { fg(color: string, text: string): string }): boolean {
	return Boolean(theme && theme.fg("accent", "x") !== "x");
}

function ctpBandColor(safePercent: number): CtpColor {
	if (safePercent > 85) return "red";
	if (safePercent > 70) return "peach";
	if (safePercent > 50) return "yellow";
	if (safePercent > 25) return "teal";
	return "green";
}

function providerCtpColor(providerId: string): CtpColor {
	if (providerId.includes("antigravity") || providerId.includes("gemini")) return "sapphire";
	if (providerId.includes("codex") || providerId.includes("openai")) return "green";
	if (providerId.includes("claude")) return "peach";
	if (providerId.includes("deepseek")) return "blue";
	return "teal";
}

function usageBandColor(safePercent: number): string {
	if (safePercent > 85) return "error";
	if (safePercent > 60) return "warning";
	if (safePercent > 30) return "accent";
	return "success";
}

/** Build a single bar segment: filled/empty cells + percent + reset countdown. */
export function bar(
	percent: number,
	resets: Record<string, number> | undefined,
	key: string,
	theme: { fg(color: string, text: string): string },
	now = Date.now(),
): string {
	const safePercent = normalizePercent(percent) ?? 0;
	const filled = Math.round((safePercent / 100) * BAR_CELLS);
	const empty = BAR_CELLS - filled;
	const useCtp = isColorTheme(theme);
	const band = ctpBandColor(safePercent);
	const color = usageBandColor(safePercent);
	const filledPart =
		filled > 0
			? useCtp
				? ctp(band, "█".repeat(filled))
				: theme.fg(color, "█".repeat(filled))
			: "";
	const emptyPart =
		empty > 0
			? useCtp
				? ctp("surface2", "░".repeat(empty))
				: theme.fg("dim", "░".repeat(empty))
			: "";
	const pctPart = useCtp ? ctp(band, `${safePercent}%`) : theme.fg(color, `${safePercent}%`);
	let out = `${filledPart}${emptyPart}  ${pctPart}`;
	const r = resets?.[key];
	if (typeof r === "number" && Number.isFinite(r)) {
		const lbl = resetLabel(r, now);
		out += ` ${useCtp ? ctp("subtext0", lbl) : theme.fg("muted", lbl)}`;
	}
	return out;
}

/**
 * One window rendered per style: `bar()` output for "bars", a bare
 * colorized percentage for "percent" — both with the reset countdown.
 */
export function windowSegment(
	percent: number,
	resets: Record<string, number> | undefined,
	key: string,
	theme: { fg(color: string, text: string): string },
	style: UsageStyle,
	now = Date.now(),
): string {
	if (style === "percent") {
		const safePercent = normalizePercent(percent) ?? 0;
		const useCtp = isColorTheme(theme);
		const band = ctpBandColor(safePercent);
		const color = usageBandColor(safePercent);
		let out = useCtp ? ctp(band, `${safePercent}%`) : theme.fg(color, `${safePercent}%`);
		const r = resets?.[key];
		if (typeof r === "number" && Number.isFinite(r)) {
			const lbl = resetLabel(r, now);
			out += ` ${useCtp ? ctp("subtext0", lbl) : theme.fg("muted", lbl)}`;
		}
		return out;
	}
	return bar(percent, resets, key, theme, now);
}

/** Label + separator + segment, e.g. `R: █░░░░░ 42% ~4h` or `R 42% ~4h`. */
function labeledWindow(
	label: string,
	percent: number,
	resets: Record<string, number> | undefined,
	key: string,
	theme: { fg(color: string, text: string): string },
	style: UsageStyle,
	now = Date.now(),
): string {
	const sep = style === "percent" ? " " : ": ";
	const lbl = isColorTheme(theme) ? ctp("lavender", label) : theme.fg("accent", label);
	return `${lbl}${sep}${windowSegment(percent, resets, key, theme, style, now)}`;
}

/** Join window segments with a dim middot (footer collapses runs of spaces). */
function joinParts(
	parts: string[],
	theme: { fg(color: string, text: string): string },
): string {
	const dot = isColorTheme(theme) ? ctp("overlay1", "·") : theme.fg("dim", "·");
	return parts.join(` ${dot} `);
}


/** Plain (theme-free) bar cells for the detailed `/usage` readout. */
export function detailBar(percent: number): string {
	const safePercent = normalizePercent(percent) ?? 0;
	const filled = Math.round((safePercent / 100) * BAR_CELLS);
	return "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

/** Preferred window order for the detailed readout; unknown keys sort alphabetically after. */
const DETAIL_WINDOW_ORDER = [
	"5h",
	"rolling",
	"daily",
	"gemini-5h",
	"3p-5h",
	"weekly",
	"7d",
	"gemini-weekly",
	"3p-weekly",
	"monthly",
] as const;

function detailWindowOrder(key: string): number {
	const idx = (DETAIL_WINDOW_ORDER as readonly string[]).indexOf(key);
	return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

/** Compact age label for `fetchedAt`, e.g. "just now", "5m ago", "3h ago". */
export function fetchAgeLabel(fetchedAt: number, now = Date.now()): string {
	if (!Number.isFinite(fetchedAt) || !Number.isFinite(now)) return "unknown age";
	const age = now - fetchedAt;
	if (age < 0) return "just now";
	if (age < 60_000) return "just now";
	const m = Math.floor(age / 60_000);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
	USD: "$",
	CNY: "¥",
	EUR: "€",
	GBP: "£",
	JPY: "¥",
};

/** Compact balance label, e.g. `$12.34`, or `12.34 SGD` for unknown currencies. */
export function formatBalance(balance: UsageBalance): string {
	const amount = balance.total.toFixed(2);
	const symbol = CURRENCY_SYMBOLS[balance.currency];
	return symbol ? `${symbol}${amount}` : `${amount} ${balance.currency}`;
}

/**
 * Full multi-line breakdown of every usage window for a provider.
 *
 * Used by the `/usage` command (plain text for `ctx.ui.notify`), unlike the
 * single-line widget `render()` which is theme-colored and limited to the
 * active model's pool. Shows per-window percent + bar + relative reset
 * countdown + absolute reset time, plus plan and freshness when known.
 */
function detailColoredBar(
	percent: number,
	c: (color: CtpColor, text: string) => string,
): string {
	const safe = normalizePercent(percent) ?? 0;
	const filled = Math.round((safe / 100) * BAR_CELLS);
	const empty = BAR_CELLS - filled;
	const band = ctpBandColor(safe);
	const f = filled > 0 ? c(band, "█".repeat(filled)) : "";
	const e = empty > 0 ? c("surface2", "░".repeat(empty)) : "";
	return `${f}${e}`;
}

function shortWindowKey(key: string): string {
	if (key === "3p-5h" || key === "gemini-5h" || key === "deepseek-5h" || key === "5h") return "5h";
	if (key === "3p-weekly" || key === "gemini-weekly" || key === "weekly" || key === "7d") return "W ";
	if (key === "daily") return "1d";
	if (key === "monthly") return "1m";
	if (key === "rolling") return "R ";
	return key;
}

type FormatUsageOptions = {
	modelId?: string;
	fetchedAt?: number;
	now?: number;
	theme?: { fg(color: string, text: string): string };
	active?: boolean;
};

export function formatUsageDetails(data: UsageData, providerId: string, options: FormatUsageOptions = {}): string {
	const now = options.now ?? Date.now();
	const hasColor = isColorTheme(options.theme);
	const c = (color: CtpColor, text: string) => (hasColor ? ctp(color, text) : text);

	const normalized = normalizeUsageData(data);
	if (!normalized) return `${c('overlay1', providerId)}: ${c('surface2', 'no usage data')}`;

	if (hasColor) return renderCompactUsage({ normalized, providerId, options, now, c });
	return renderPlainUsage({ normalized, providerId, options, now, c });

}


/** Everything both renderers read, destructured to the names the bodies already use. */
type UsageRenderContext = {
	normalized: UsageData;
	providerId: string;
	options: FormatUsageOptions;
	now: number;
	c: (color: CtpColor, text: string) => string;
};

function renderCompactUsage({ normalized, providerId, options, now, c }: UsageRenderContext): string {
	const pColor = providerCtpColor(providerId);
	const isActive = Boolean(options.active || options.modelId);
	const leadIcon = isActive ? c('yellow', '⚡') : c(pColor, '◆');
	const sepPipe = c('surface2', ' │ ');

	// Antigravity reports separate gemini-* and 3p-* (Claude/GPT) pools. For the
	// active model show only its pool; otherwise show both with pool-tagged labels.
	const poolPrefix = options.modelId ? (/claude|gpt/i.test(options.modelId) ? '3p-' : 'gemini-') : undefined;
	let poolFiltered = false;
	const selectPoolKeys = (keys: string[]): string[] => {
		if (!poolPrefix) return keys;
		const matched = keys.filter((k) => k.startsWith(poolPrefix));
		if (matched.length === 0) return keys;
		poolFiltered = true;
		return matched;
	};
	const windowLabel = (key: string): string => {
		if (!poolFiltered) {
			if (key === 'gemini-5h') return 'G·5h';
			if (key === 'gemini-weekly') return 'G·W ';
			if (key === '3p-5h') return '3P·5h';
			if (key === '3p-weekly') return '3P·W ';
		}
		return shortWindowKey(key);
	};
	const poolTag = (): { plain: string; colored: string } => {
		if (!poolFiltered) return { plain: '', colored: '' };
		const name = poolPrefix === '3p-' ? 'Claude/GPT pool' : 'Gemini pool';
		return { plain: ` • ${name}`, colored: `${c('overlay1', ' • ')}${c('teal', name)}` };
	};

	const renderCompactHeader = (metaPlain: string, metaColored: string): string => {
		const hasFresh =
			typeof options.fetchedAt === 'number' && Number.isFinite(options.fetchedAt) && options.fetchedAt > 0;
		const freshPlain = hasFresh ? ` ↻ ${fetchAgeLabel(options.fetchedAt!, now)}` : '';
		const ageMs = hasFresh ? Math.max(0, now - options.fetchedAt!) : 0;
		const ageColor: CtpColor = ageMs < 3_600_000 ? 'green' : ageMs < 12 * 3_600_000 ? 'yellow' : 'overlay1';
		const freshColored = hasFresh ? ` ${c(ageColor, `↻ ${fetchAgeLabel(options.fetchedAt!, now)}`)}` : '';
		const leftPlainLen = 2 + providerId.length + metaPlain.length;
		const targetWidth = 78;
		const ruleLen = Math.max(3, targetWidth - leftPlainLen - freshPlain.length - 1);
		const rule = ` ${c('surface2', '─'.repeat(ruleLen))}`;
		return `${leadIcon} ${c(pColor, providerId)}${metaColored}${rule}${freshColored}`;
	};

	const renderCompactCell = (
		key: string,
		percent: number,
		resets: Record<string, number> | undefined,
	): { text: string; width: number } => {
		const safe = normalizePercent(percent) ?? 0;
		const reset = resets?.[key];
		const hasReset = typeof reset === 'number' && Number.isFinite(reset);
		const expired = hasReset && reset <= now;
		const shownPct = expired ? 0 : safe;
		const band: CtpColor = expired ? 'overlay1' : ctpBandColor(safe);
		const cells = detailColoredBar(shownPct, c);
		const rawKey = windowLabel(key);
		const rawPct = `${shownPct}%`.padStart(4);
		const sKey = c('lavender', rawKey);
		const sPct = c(band, rawPct);
		if (hasReset) {
			const rawRel = expired ? 'done' : resetLabel(reset, now).padEnd(4);
			const rawAbs = `(${vnShortStamp(reset, now)})`;
			const rel = expired ? c('teal', rawRel) : c('yellow', rawRel);
			const abs = c(expired ? 'surface2' : 'subtext0', rawAbs);
			const width = rawKey.length + 1 + BAR_CELLS + 1 + rawPct.length + 1 + rawRel.length + 1 + rawAbs.length;
			return { text: `${sKey} ${cells} ${sPct} ${rel} ${abs}`, width };
		}
		const width = rawKey.length + 1 + BAR_CELLS + 1 + rawPct.length;
		return { text: `${sKey} ${cells} ${sPct}`, width };
	};

	if (normalized.accounts && (normalized.accounts.length > 1 || providerId === 'codex-pool')) {
		const sortedAccounts = [...normalized.accounts].sort((a, b) => {
			if (a.active !== b.active) return a.active ? -1 : 1;
			if (a.cooldown !== b.cooldown) return a.cooldown ? 1 : -1;
			return a.id.localeCompare(b.id);
		});

		const maxIdLen = Math.max(...sortedAccounts.map((a) => (a.name ?? a.id).length));
		const badgeLabel = (a: (typeof sortedAccounts)[number]) =>
			(a.plan === 'self_serve_business_prolite' ? 'Business (Pro Lite)' : a.plan) ??
			(a.active ? 'active' : a.cooldown ? 'cooldown' : 'standby');
		const maxBadgeLen = Math.max(...sortedAccounts.map((a) => badgeLabel(a).length));

		const accountRows = sortedAccounts.map((acc) => {
			const stateColor: CtpColor = acc.active ? 'green' : acc.cooldown ? 'yellow' : 'sapphire';
			const rawIcon = acc.active ? '●' : acc.cooldown ? '⏳' : '○';
			const icon = c(stateColor, rawIcon);
			const idText = c(acc.active ? 'text' : 'subtext0', (acc.name ?? acc.id).padEnd(maxIdLen));
			const bRaw = badgeLabel(acc).padEnd(maxBadgeLen);
			const bColor: CtpColor = acc.plan === 'Ultra' ? 'pink' : acc.active ? 'green' : acc.cooldown ? 'yellow' : 'mauve';
			const badge = `${c('overlay1', '[')}${c(bColor, bRaw)}${c('overlay1', ']')}`;

			const keys = selectPoolKeys(Object.keys(acc.windows)).sort((a, b) => {
				const order = detailWindowOrder(a) - detailWindowOrder(b);
				return order !== 0 ? order : a.localeCompare(b);
			});
			const cells: { text: string; width: number }[] = [];
			for (const key of keys) {
				const percent = acc.windows[key];
				if (typeof percent !== 'number') continue;
				cells.push(renderCompactCell(key, percent, acc.resets));
			}
			return { prefix: `  ${icon} ${idText} ${badge}  `, cells };
		});

		const tag = poolTag();
		const metaPlain = ` (${normalized.accounts.length} pooled${options.modelId ? ` • ${options.modelId}` : ''}${tag.plain})`;
		const metaColored =
			`${c('overlay1', ' (')}${c('sky', `${normalized.accounts.length} pooled`)}` +
			(options.modelId ? `${c('overlay1', ' • ')}${c('flamingo', options.modelId)}` : '') +
			tag.colored +
			c('overlay1', ')');
		const lines: string[] = [renderCompactHeader(metaPlain, metaColored)];

		const colCount = Math.max(0, ...accountRows.map((r) => r.cells.length));
		const colWidths = Array.from({ length: colCount }, (_, colIdx) =>
			Math.max(0, ...accountRows.map((r) => r.cells[colIdx]?.width ?? 0)),
		);

		for (const row of accountRows) {
			const paddedCells = row.cells.map((cell, idx) =>
				idx < row.cells.length - 1 ? cell.text + ' '.repeat(Math.max(0, colWidths[idx] - cell.width)) : cell.text,
			);
			lines.push(`${row.prefix}${paddedCells.join(sepPipe)}`);
		}
		return lines.join('\n');
	}

	// Single-account compact dashboard block
	const keys = selectPoolKeys(Object.keys(normalized.windows)).sort((a, b) => {
		const order = detailWindowOrder(a) - detailWindowOrder(b);
		return order !== 0 ? order : a.localeCompare(b);
	});
	const metaPartsPlain: string[] = [];
	const metaPartsColored: string[] = [];
	if (normalized.plan) {
		metaPartsPlain.push(normalized.plan);
		metaPartsColored.push(c('pink', normalized.plan));
	}
	if (options.modelId) {
		metaPartsPlain.push(options.modelId);
		metaPartsColored.push(c('flamingo', options.modelId));
	}
	const singleTag = poolTag();
	const metaPlain = metaPartsPlain.length > 0 ? ` (${metaPartsPlain.join(' • ')}${singleTag.plain})` : '';
	const metaColored =
		metaPartsColored.length > 0
			? `${c('overlay1', ' (')}${metaPartsColored.join(c('overlay1', ' • '))}${singleTag.colored}${c('overlay1', ')')}`
			: '';
	const lines: string[] = [renderCompactHeader(metaPlain, metaColored)];

	const windowCells: string[] = [];
	for (const key of keys) {
		const percent = normalized.windows[key];
		if (typeof percent !== 'number') continue;
		windowCells.push(`${c('mauve', '•')} ${renderCompactCell(key, percent, normalized.resets).text}`);
	}
	if (typeof normalized.resetsLeft === 'number' && normalized.resetsLeft > 0) {
		const label = normalized.resetsLeft === 1 ? '1 reset left' : `${normalized.resetsLeft} resets left`;
		windowCells.push(c('green', `↻ ${label}`));
	}
	if (normalized.balance) {
		windowCells.push(`${c('lavender', 'bal')} ${c('green', formatBalance(normalized.balance))}`);
	}
	if (windowCells.length > 0) {
		lines.push(`  ${windowCells.join(sepPipe)}`);
	}
	if (usesDeepSeekPeakPricing(providerId, options.modelId)) {
		const peak = getDeepSeekPeakInfo(now);
		const tag = peak.isPeak ? `Peak hours ${resetLabel(peak.nextFlipMs, now)} left` : deepSeekOffPeakDetail(peak, now);
		lines.push(
			`  ${c('mauve', '•')} ${c('lavender', 'deepseek:')} ${c(peak.isPeak ? 'peach' : 'green', tag)}${sepPipe}${c('subtext0', formatDeepSeekPeakWindows(now))}`,
		);
	}
	return lines.join('\n');
}

function renderPlainUsage({ normalized, providerId, options, now }: UsageRenderContext): string {
	// Plain-text format (unit tests & non-color environments)
	const renderWindowLine = (key: string, percent: number, resets: Record<string, number> | undefined) => {
		const safe = normalizePercent(percent) ?? 0;
		const cells = detailBar(safe);
		const paddedKey = key.padEnd(9);
		const paddedPct = `${safe}%`.padStart(4);
		const reset = resets?.[key];
		if (typeof reset === 'number' && Number.isFinite(reset)) {
			return `  \u2022 ${paddedKey} ${paddedPct} ${cells}  resets ${resetLabel(reset, now)} (${vnStamp(reset, now)})`;
		}
		return `  \u2022 ${paddedKey} ${paddedPct} ${cells}`;
	};

	if (normalized.accounts && (normalized.accounts.length > 1 || providerId === 'codex-pool')) {
		const poolLabel = ` (${normalized.accounts.length} accounts pooled)`;
		const headerModel = options.modelId ? ` \u2022 ${options.modelId}` : '';
		const lines: string[] = [`Subscription usage \u2014 ${providerId}${poolLabel}${headerModel}`];
		const sortedAccounts = [...normalized.accounts].sort((a, b) => {
			if (a.active !== b.active) return a.active ? -1 : 1;
			if (a.cooldown !== b.cooldown) return a.cooldown ? 1 : -1;
			return a.id.localeCompare(b.id);
		});

		for (const acc of sortedAccounts) {
			lines.push('');
			const icon = acc.active ? '\u25CF' : acc.cooldown ? '\u23F3' : '\u25CB';
			const status = acc.active ? 'active' : acc.cooldown ? 'cooldown' : 'standby';
			const planText = acc.plan ? ` \u2022 ${acc.plan}` : '';
			lines.push(`${icon} ${acc.id} [${status}${planText}]`);
			const keys = Object.keys(acc.windows).sort((a, b) => {
				const order = detailWindowOrder(a) - detailWindowOrder(b);
				return order !== 0 ? order : a.localeCompare(b);
			});
			for (const key of keys) {
				const percent = acc.windows[key];
				if (typeof percent !== 'number') continue;
				lines.push(renderWindowLine(key, percent, acc.resets));
			}
		}
		if (typeof options.fetchedAt === 'number' && Number.isFinite(options.fetchedAt) && options.fetchedAt > 0) {
			lines.push('');
			lines.push(`Updated ${fetchAgeLabel(options.fetchedAt, now)}`);
		}
		return lines.join('\n');
	}

	const headerPlan = normalized.plan ? ` (${normalized.plan})` : '';
	const headerModel = options.modelId ? ` \u2022 ${options.modelId}` : '';
	const lines: string[] = [`Subscription usage \u2014 ${providerId}${headerPlan}${headerModel}`];
	const keys = Object.keys(normalized.windows).sort((a, b) => {
		const order = detailWindowOrder(a) - detailWindowOrder(b);
		return order !== 0 ? order : a.localeCompare(b);
	});
	for (const key of keys) {
		const percent = normalized.windows[key];
		if (typeof percent !== 'number') continue;
		lines.push(renderWindowLine(key, percent, normalized.resets));
	}
	if (typeof normalized.resetsLeft === 'number') {
		const label = normalized.resetsLeft === 1 ? '1 left' : `${normalized.resetsLeft} left`;
		lines.push(`  \u2022 resets:   ${label}`);
	}
	if (normalized.balance) {
		lines.push(`  \u2022 balance:  ${formatBalance(normalized.balance)}`);
	}
	if (usesDeepSeekPeakPricing(providerId, options.modelId)) {
		const peak = getDeepSeekPeakInfo(now);
		const tag = peak.isPeak ? `Peak hours ${resetLabel(peak.nextFlipMs, now)} left` : deepSeekOffPeakDetail(peak, now);
		lines.push(`  \u2022 deepseek: ${tag}`);
		lines.push(`  \u2022 peak win: ${formatDeepSeekPeakWindows(now)}`);
	}
	if (typeof options.fetchedAt === 'number' && Number.isFinite(options.fetchedAt) && options.fetchedAt > 0) {
		lines.push(`Updated ${fetchAgeLabel(options.fetchedAt, now)}`);
	}
	return lines.join('\n');
}
/** ±JITTER_RATIO randomization so timers don't line up across instances. */
function jitter(ms: number): number {
	return Math.round(ms * (1 + (Math.random() * 2 - 1) * JITTER_RATIO));
}

/**
 * DeepSeek bills on a UTC clock: two peak windows on weekdays, with a 50%
 * off-peak discount during every other hour. Weekends are off-peak in full.
 * Windows are stored as UTC minutes from midnight so they stay correct across
 * DST changes.
 */
export const DEEPSEEK_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
	[1 * 60, 4 * 60], // 01:00 - 04:00 UTC
	[6 * 60, 10 * 60], // 06:00 - 10:00 UTC
];

/** Peak billing applies Monday–Friday (UTC weekday); weekends never bill peak. */
export function isDeepSeekPeakDay(ms: number): boolean {
	const day = new Date(ms).getUTCDay();
	return day !== 0 && day !== 6;
}

/** Off-peak stretches at least this long also show an absolute resume time. */
const DEEPSEEK_LONG_OFFPEAK_MS = 86_400_000;

/**
 * Peak-hour state for DeepSeek's UTC billing windows. `windowStartMs` and
 * `windowEndMs` describe the active window while peak, or the next weekday
 * window while off-peak, so callers can render a local range without
 * re-deriving it.
 */
export interface DeepSeekPeakInfo {
	isPeak: boolean;
	nextFlipMs: number;
	windowStartMs: number;
	windowEndMs: number;
	/** Set while off-peak because the current UTC day is Saturday or Sunday. */
	reason?: "weekend";
}

/** Local calendar-day index, used to mark windows that cross local midnight. */
function localDayIndex(ms: number): number {
	return Math.floor((ms - new Date(ms).getTimezoneOffset() * 60_000) / 86_400_000);
}

/** `HH:MM` in local time, ` +1`/` -1` when the edge lands after/before `referenceDay`. */
function localClock(ms: number, referenceDay: number): string {
	const date = new Date(ms);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const offset = localDayIndex(ms) - referenceDay;
	const suffix = offset > 0 ? " +1" : offset < 0 ? " -1" : "";
	return `${hh}:${mm}${suffix}`;
}

/** Format an absolute window as a local `HH:MM–HH:MM` range. */
export function formatLocalTimeRange(startMs: number, endMs: number, now = Date.now()): string {
	const referenceDay = localDayIndex(now);
	return `${localClock(startMs, referenceDay)}–${localClock(endMs, referenceDay)}`;
}

/** `HH:MM` for a UTC minutes-from-midnight value. */
function utcClock(minutes: number): string {
	const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
	const mm = String(minutes % 60).padStart(2, "0");
	return `${hh}:${mm}`;
}

/**
 * UTC midnight of the day whose local clock times the peak windows render
 * against: today when it is a weekday, otherwise the next weekday. Anchoring a
 * weekend to the coming weekday keeps the local ranges from describing a day
 * that never bills peak, and keeps them correct across a DST change.
 */
function deepSeekWindowAnchor(now: number): number {
	const d = new Date(now);
	const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	for (let offset = 0; offset <= 7; offset++) {
		const midnight = today + offset * 86_400_000;
		if (isDeepSeekPeakDay(midnight)) return midnight;
	}
	return today;
}

/** Both peak windows as local ranges, plus their canonical UTC ranges. */
export function formatDeepSeekPeakWindows(now = Date.now()): string {
	const anchor = deepSeekWindowAnchor(now);
	const local = DEEPSEEK_PEAK_WINDOWS.map(([start, end]) =>
		formatLocalTimeRange(anchor + start * 60_000, anchor + end * 60_000, anchor),
	).join(", ");
	const utc = DEEPSEEK_PEAK_WINDOWS.map(
		([start, end]) => `${utcClock(start)}–${utcClock(end)} UTC`,
	).join(", ");
	return `${local} (local) · ${utc} · Mon–Fri (UTC)`;
}

/**
 * Peak-hour state for DeepSeek's UTC billing windows at `now`. Peak runs
 * Monday–Friday only, so weekend off-peak resolves to the next weekday
 * window; `reason` marks the weekend case for callers that explain the wait.
 */
export function getDeepSeekPeakInfo(now = Date.now()): DeepSeekPeakInfo {
	const d = new Date(now);
	const utcMins = d.getUTCHours() * 60 + d.getUTCMinutes();
	const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	const weekend = !isDeepSeekPeakDay(now);

	if (!weekend) {
		for (const [start, end] of DEEPSEEK_PEAK_WINDOWS) {
			if (utcMins >= start && utcMins < end) {
				const windowStartMs = utcMidnight + start * 60_000;
				const windowEndMs = utcMidnight + end * 60_000;
				return { isPeak: true, nextFlipMs: windowEndMs, windowStartMs, windowEndMs };
			}
		}
	}

	// Off-peak: the next window on the nearest weekday, skipping the weekend.
	for (let offset = 0; offset <= 7; offset++) {
		const midnight = utcMidnight + offset * 86_400_000;
		if (!isDeepSeekPeakDay(midnight)) continue;
		for (const [start, end] of DEEPSEEK_PEAK_WINDOWS) {
			const windowStartMs = midnight + start * 60_000;
			if (windowStartMs <= now) continue;
			return {
				isPeak: false,
				nextFlipMs: windowStartMs,
				windowStartMs,
				windowEndMs: midnight + end * 60_000,
				...(weekend ? { reason: "weekend" as const } : {}),
			};
		}
	}

	// Unreachable with the current window table (a weekday always follows
	// within three days); kept so callers never see a non-finite countdown.
	const [start, end] = DEEPSEEK_PEAK_WINDOWS[0];
	const tomorrow = utcMidnight + 86_400_000;
	return {
		isPeak: false,
		nextFlipMs: tomorrow + start * 60_000,
		windowStartMs: tomorrow + start * 60_000,
		windowEndMs: tomorrow + end * 60_000,
		...(weekend ? { reason: "weekend" as const } : {}),
	};
}

/** True when the active provider/model bills on DeepSeek's peak-hour windows. */
export function usesDeepSeekPeakPricing(providerId?: string, modelId?: string): boolean {
	if (providerId === "deepseek") return true;
	return Boolean(modelId && /deepseek/i.test(modelId));
}

/**
 * Detailed off-peak line for the `/usage` readout: flip countdown, the weekend
 * reason when it applies, and — past a day — the absolute resume time.
 */
function deepSeekOffPeakDetail(peak: DeepSeekPeakInfo, now: number): string {
	const reason = peak.reason ? ` (${peak.reason})` : "";
	const resume =
		peak.nextFlipMs - now >= DEEPSEEK_LONG_OFFPEAK_MS
			? ` — resumes ${utcStamp(peak.nextFlipMs)}`
			: "";
	return `Off-peak ${resetLabel(peak.nextFlipMs, now)} until peak${reason}${resume}`;
}

/** Theme-colored peak/off-peak tag with the weekend reason and countdown. */
export function deepSeekPeakTag(
	theme: { fg(color: string, text: string): string },
	now = Date.now(),
): string {
	const peak = getDeepSeekPeakInfo(now);
	if (peak.isPeak) return theme.fg("warning", `Peak ${resetLabel(peak.nextFlipMs, now)}`);
	const reason = peak.reason ? ` (${peak.reason})` : "";
	return theme.fg("dim", `Off-Peak ${resetLabel(peak.nextFlipMs, now)}${reason}`);
}

/** Earliest reset deadline across all tracked windows (ms epoch), if any. */
export function earliestReset(
	data: UsageData | undefined,
	modelId?: string,
	providerId?: string,
	now = Date.now(),
): number | undefined {
	const times = data?.resets
		? Object.values(data.resets).filter((value) => Number.isFinite(value))
		: [];
	if (usesDeepSeekPeakPricing(providerId, modelId)) {
		times.push(getDeepSeekPeakInfo(now).nextFlipMs);
	}
	return times.length ? Math.min(...times) : undefined;
}

/** OpenCode Go: rolling / weekly / monthly usage windows. */
const OPENCODE_WINDOW_LABELS = {
	rolling: "R",
	weekly: "W",
	monthly: "M",
} as const;

function anySignal(a?: AbortSignal, b?: AbortSignal): AbortSignal {
	if (!a) return b ?? new AbortController().signal;
	if (!b) return a;
	return AbortSignal.any([a, b]);
}

/** Read only public error fields, never dump response bodies or credentials. */
async function usageHttpError(res: Response, provider: string, secrets: string[]): Promise<Error> {
	let detail = "";
	try {
		const json = asRecord(await res.json());
		const error = asRecord(json?.error);
		detail = [...new Set([
			error?.status, error?.code, error?.message,
			typeof json?.error === "string" ? json.error : undefined,
			json?.error_description, json?.message,
		].filter((value): value is string => typeof value === "string"))].join(": ");
		for (const secret of secrets) {
			if (secret) detail = detail.replaceAll(secret, "[REDACTED]");
		}
		// API text is untrusted terminal output; strip control characters.
		detail = detail.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
	} catch {
		// HTML gateways, empty bodies, and unreadable responses still have a status.
	}
	const hint = res.status === 401 || res.status === 403 || /invalid_grant/.test(detail)
		? provider === "openai-codex" || provider === "antigravity"
			? `; use /login for ${provider} or replace the environment token${res.status === 403 ? "; check account permissions/license if it persists" : ""}`
			: "; check API key credentials and account permissions"
		: "";
	return new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}${hint}`);
}

export const opencodeCfg: ProviderCfg = {
	id: "opencode-go",
	async fetchUsage(signal?: AbortSignal) {
		const rawEnv = process.env.OPENCODE_API_KEY?.trim();
		const cred = rawEnv ? undefined : readStoredCredential("opencode-go");
		const key =
			(rawEnv && rawEnv.length > 0 ? rawEnv : undefined) ??
			(cred && cred.type === "api_key" ? cred.key : undefined);
		if (!key)
			throw new MissingCredentialError("no API key (OPENCODE_API_KEY or auth.json)");

		const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
			headers: { Authorization: `Bearer ${key}` },
			signal: anySignal(signal, AbortSignal.timeout(10_000)),
		});
		if (!res.ok) throw await usageHttpError(res, "opencode-go", [key]);
		const json = (await res.json()) as {
			usage?: Record<
				string,
				{
					status?: string;
					percent?: number;
					usagePercent?: number;
					resetsAt?: string;
				}
			>;
		};
		const windows: Record<string, number> = {};
		const resets: Record<string, number> = {};
		for (const k of ["rolling", "weekly", "monthly"] as const) {
			const w = json.usage?.[k];
			if (!w) continue;
			// Real API reports `percent`; tolerate `usagePercent` on other
			// backend shapes.
			const p = normalizePercent(w.percent) ?? normalizePercent(w.usagePercent);
			if (p === undefined) continue;
			windows[k] = p;
			const r = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
			if (!Number.isNaN(r)) resets[k] = r;
		}
		if (Object.keys(windows).length === 0) throw new Error("no usage data");
		return { windows, resets };
	},
	render(data, theme, modelId, style = "bars") {
		const w = data.windows;
		const parts: string[] = [];
		for (const k of ["rolling", "weekly", "monthly"] as const) {
			const val = w[k];
			if (typeof val === "number") {
				parts.push(
					labeledWindow(
						OPENCODE_WINDOW_LABELS[k],
						val,
						data.resets,
						k,
						theme,
						style,
					),
				);
			}
		}
		if (parts.length === 0) return "";

		// DeepSeek pools flip on peak-hour windows; surface the local window
		// plus the countdown to the next flip.
		if (!usesDeepSeekPeakPricing("opencode-go", modelId)) return joinParts(parts, theme);
		return joinParts([deepSeekPeakTag(theme), ...parts], theme);
	},
};

/** DeepSeek API (pay-as-you-go): account balance plus peak/off-peak billing state. */
export const deepseekCfg: ProviderCfg = {
	id: "deepseek",
	async fetchUsage(signal?: AbortSignal) {
		const rawEnv = process.env.DEEPSEEK_API_KEY?.trim();
		const cred = rawEnv ? undefined : readStoredCredential("deepseek");
		const key =
			(rawEnv && rawEnv.length > 0 ? rawEnv : undefined) ??
			(cred && cred.type === "api_key" ? cred.key : undefined);
		if (!key)
			throw new MissingCredentialError("no API key (DEEPSEEK_API_KEY or auth.json)");

		const res = await fetch("https://api.deepseek.com/user/balance", {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
			signal: anySignal(signal, AbortSignal.timeout(10_000)),
		});
		if (!res.ok) throw await usageHttpError(res, "deepseek", [key]);
		const json = (await res.json()) as {
			balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }>;
		};

		// Prefer USD when the account holds several currencies.
		const balances = (json.balance_infos ?? []).flatMap((entry) => {
			const record = asRecord(entry);
			const currency =
				typeof record?.currency === "string"
					? record.currency.trim().toUpperCase()
					: "";
			const total = Number.parseFloat(String(record?.total_balance ?? ""));
			return currency && Number.isFinite(total) ? [{ currency, total }] : [];
		});
		const balance = balances.find((entry) => entry.currency === "USD") ?? balances[0];
		if (!balance) throw new Error("no balance data");
		return { windows: {}, balance };
	},
	render(data, theme) {
		const parts = [deepSeekPeakTag(theme)];
		if (data.balance) parts.push(formatBalance(data.balance));
		return joinParts(parts, theme);
	},
};

export interface RateLimitWindowSnapshot {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

export interface CodexUsageResponse {
	plan_type?: string;
	rate_limit?: {
		allowed?: boolean;
		limit_reached?: boolean;
		primary_window?: RateLimitWindowSnapshot | null;
		secondary_window?: RateLimitWindowSnapshot | null;
	};
	rate_limit_reset_credits?: {
		available_count?: number;
		applicable_available_count?: number;
	} | null;
}

export function codexWindowKey(
	w: { limit_window_seconds?: number },
	fallback = "primary",
): string {
	const sec = w.limit_window_seconds;
	if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0)
		return fallback;
	if (sec >= 14_400 && sec <= 21_600) return "5h"; // ~5h (18000s)
	if (sec >= 72_000 && sec <= 100_000) return "daily"; // ~24h (86400s)
	if (sec >= 500_000 && sec <= 700_000) return "weekly"; // ~7d (604800s)
	if (sec >= 2_000_000 && sec <= 3_000_000) return "monthly"; // ~30d (2592000s)
	if (sec >= 3600) return `${Math.round(sec / 3600)}h`;
	return `${Math.round(sec / 60)}m`;
}

export function parseCodexUsage(json: CodexUsageResponse): UsageData {
	const windows: Record<string, number> = {};
	const resets: Record<string, number> = {};
	const addWindow = (
		window: RateLimitWindowSnapshot | null | undefined,
		fallback: string,
	): void => {
		if (!window) return;
		const percent = normalizePercent(window.used_percent);
		if (percent === undefined) return;
		let key = codexWindowKey(window, fallback);
		if (key in windows) key = "secondary";
		windows[key] = percent;
		if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at)) {
			resets[key] = Math.max(0, window.reset_at * 1000);
		}
	};

	const hasSecondary = Boolean(json.rate_limit?.secondary_window);
	addWindow(json.rate_limit?.primary_window, hasSecondary ? "5h" : "weekly");
	addWindow(json.rate_limit?.secondary_window, "weekly");

	if (Object.keys(windows).length === 0) throw new Error("no usage data");
	const rawResetsLeft = json.rate_limit_reset_credits?.available_count;
	const resetsLeft =
		typeof rawResetsLeft === "number" && Number.isFinite(rawResetsLeft) && rawResetsLeft >= 0
			? Math.floor(rawResetsLeft)
			: undefined;
	const normalized = normalizeUsageData({
		windows,
		plan: json.plan_type,
		resets,
		...(resetsLeft !== undefined ? { resetsLeft } : {}),
	});
	if (!normalized) throw new Error("no usage data");
	return normalized;
}

/** OpenAI Codex (ChatGPT subscription): 5h rolling & weekly primary/secondary windows + plan type. */
const CODEX_WINDOW_LABELS: Record<string, string> = {
	"5h": "5h",
	weekly: "W",
	monthly: "M",
	daily: "1d",
};

export const codexCfg: ProviderCfg = {
	id: "openai-codex",
	async fetchUsage(signal?: AbortSignal) {
		const fromEnv = (
			process.env.OPENAI_CODEX_TOKEN ||
			process.env.CODEX_ACCESS_TOKEN ||
			process.env.CHATGPT_ACCESS_TOKEN
		)?.trim();
		const cred = fromEnv ? undefined : readStoredCredential("openai-codex");
		const access =
			(fromEnv && fromEnv.length > 0 ? fromEnv : undefined) ??
			(cred && cred.type === "oauth" ? cred.access : undefined);
		if (!access) throw new MissingCredentialError("no OAuth token for openai-codex");

		return fetchCodexUsage(access, signal);
	},
	render(data, theme, _modelId, style = "bars") {
		const w = data.windows;
		const parts: string[] = [];

		const orderedKeys = ["5h", "daily", "weekly", "monthly"];
		const seen = new Set<string>();

		for (const k of orderedKeys) {
			if (typeof w[k] === "number") {
				seen.add(k);
				const label = CODEX_WINDOW_LABELS[k] ?? k;
				parts.push(labeledWindow(label, w[k], data.resets, k, theme, style));
			}
		}

		for (const [k, v] of Object.entries(w)) {
			if (!seen.has(k) && typeof v === "number") {
				parts.push(labeledWindow(k, v, data.resets, k, theme, style));
			}
		}

		if (typeof data.resetsLeft === "number" && data.resetsLeft > 0) {
			const label = `${data.resetsLeft} reset${data.resetsLeft === 1 ? "" : "s"} left`;
			parts.push(theme.fg("dim", label));
		}

		if (parts.length === 0) return "";
		return joinParts(parts, theme);
	},
};

async function fetchCodexUsage(access: string, signal?: AbortSignal, accountId?: string): Promise<UsageData> {
	const res = await fetch("https://chatgpt.com/backend-api/codex/usage", {
		headers: {
			Authorization: `Bearer ${access}`,
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
			Accept: "application/json",
			...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
		},
		signal: anySignal(signal, AbortSignal.timeout(10_000)),
	});
	if (!res.ok) throw await usageHttpError(res, "openai-codex", [access]);
	return parseCodexUsage(await res.json() as CodexUsageResponse);
}

export const codexPoolCfg: ProviderCfg = {
	id: "codex-pool",
	sharedCache: false,
	async fetchUsage(signal) {
		const store = new AccountStore(path.join(getAgentDir(), "codex-accounts.json"));
		const { accounts, preferred } = await store.read(signal);
		// Usage polling is read-only: token rotation remains owned by the pool.
		const usable = accounts.filter((account) => !account.needsLogin && account.credential.expires > Date.now());
		if (!usable.length) throw new MissingCredentialError("no unexpired accounts for codex-pool; sign in or use the pool to refresh credentials");
		const windows: Record<string, number> = {};
		const resets: Record<string, number> = {};
		const accountUsage: NonNullable<UsageData["accounts"]> = [];
		const names = accounts.map((account, index) => accountDisplayName(account.credential, `Account ${index + 1}`));
		for (const account of usable) {
			const index = accounts.indexOf(account);
			const name = names[index];
			const labelName = names.filter((label) => label === name).length > 1 ? `${name} (Account ${index + 1})` : name;
			const data = await fetchCodexUsage(account.credential.access, signal,
				typeof account.credential.accountId === "string" ? account.credential.accountId : undefined);
			accountUsage.push({ id: account.id, name: labelName, plan: data.plan, active: account.id === (usable.some((a) => a.id === preferred) ? preferred : usable[0].id), windows: data.windows, resets: data.resets });
			for (const [key, percent] of Object.entries(data.windows)) {
				const label = `${labelName} ${key}`;
				windows[label] = percent;
				if (data.resets?.[key] !== undefined) resets[label] = data.resets[key];
			}
		}
		return { windows, resets, accounts: accountUsage, plan: `codex-pool (${usable.length}/${accounts.length} accounts)` };
	},
	render: codexCfg.render,
};

export function renderCodexPoolFooter(data: UsageData, theme: { fg(color: string, text: string): string }, selectedId?: string, style: UsageStyle = "bars"): string {
	const accounts = data.accounts ?? [];
	const account = selectedId ? accounts.find((item) => item.id === selectedId) : accounts.find((item) => item.active);
	if (!account) return theme.fg("dim", selectedId ? "Codex · usage pending" : "Codex · awaiting request");
	const name = account.name ?? "Account";
	const short = name.split("@")[0];
	const label = accounts.filter((item) => (item.name ?? "Account").split("@")[0] === short).length > 1 ? name : short;
	const nameTag = isColorTheme(theme) ? ctp("subtext0", label) : theme.fg("muted", label);
	return joinParts([nameTag, codexCfg.render(account, theme, undefined, style)].filter(Boolean), theme);
}

export const alpakyrosPoolCfg: ProviderCfg = {
	id: "alpakyros-pool",
	sharedCache: false,
	async fetchUsage(signal) {
		let config: { baseUrl: string; keys: string[] };
		try {
			config = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "alpakyros-pool.json"), "utf8"));
		} catch { throw new MissingCredentialError("no private configuration for alpakyros-pool"); }
		let url: URL;
		try { url = new URL(config.baseUrl); }
		catch { throw new MissingCredentialError("invalid private configuration for alpakyros-pool"); }
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
			!Array.isArray(config.keys) || !config.keys.length ||
			config.keys.some((key) => typeof key !== "string" || !key.trim())) {
			throw new MissingCredentialError("invalid private configuration for alpakyros-pool");
		}
		url.pathname = "/api/v1/keys/status";
		const windows: Record<string, number> = {};
		const states: string[] = [];
		for (const [index, key] of [...new Set(config.keys)].entries()) {
			const res = await fetch(url, {
				method: "POST", redirect: "error",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ key }),
				signal: anySignal(signal, AbortSignal.timeout(10_000)),
			});
			if (!res.ok) throw new Error(`alpakyros-pool status HTTP ${res.status}`);
			let data: Record<string, unknown> | undefined;
			try { data = asRecord(await res.json()); }
			catch { throw new Error("alpakyros-pool returned invalid status data"); }
			const state = data?.state;
			if (typeof state !== "string" || !/^[a-z_-]{1,32}$/.test(state)) {
				throw new Error("alpakyros-pool returned no key state");
			}
			const label = `Key ${index + 1} ${state}`;
			states.push(`${label}${data?.is_unlimited === true ? " · unlimited" : ""}`);
			const remaining = normalizePercent(asRecord(data?.key_quota)?.remaining_percentage);
			if (remaining !== undefined && data?.is_unlimited !== true) windows[label] = 100 - remaining;
		}
		return { windows, plan: states.join("; ") };
	},
	render(data, theme, modelId, style) {
		return joinParts([theme.fg("dim", data.plan ?? "Alpakyros Pool"),
			codexCfg.render(data, theme, modelId, style)].filter(Boolean), theme);
	},
};

/** codex-lb /v1/usage reports used credits, not account_pool_usage's remaining %. */
export function parseCodexLbUsage(value: unknown): UsageData {
	const json = asRecord(value);
	const windows: Record<string, number> = {};
	const resets: Record<string, number> = {};
	const pool = asRecord(json?.account_pool_usage);
	for (const [field, label] of [["primary", "5h"], ["secondary", "W"]] as const) {
		const remaining = finiteNumber(pool?.[field]);
		if (remaining !== undefined && remaining >= 0 && remaining <= 100) {
			windows[`Pool ${label} used`] = Math.round((100 - remaining + Number.EPSILON) * 10) / 10;
		}
	}
	const limits = Array.isArray(json?.limits) ? json.limits : [];
	for (const item of limits) {
		const limit = asRecord(item);
		const max = finiteNumber(limit?.max_value);
		const used = finiteNumber(limit?.current_value);
		if (max === undefined || max <= 0 || used === undefined || used < 0) continue;
		const period = limit?.limit_window;
		const kind = limit?.limit_type;
		if (typeof period !== "string" || !/^[a-zA-Z0-9_-]+$/.test(period)) continue;
		if (typeof kind !== "string" || !/^[a-zA-Z0-9_-]+$/.test(kind)) continue;
		const model = typeof limit?.model_filter === "string"
			? limit.model_filter.replace(/[^a-zA-Z0-9_.:/-]/g, "_").slice(0, 100) : "";
		const key = `Limit ${period === "7d" ? "W" : period}${kind === "credits" ? "" : ` ${kind}`}${model ? ` (${model})` : ""} used`;
		windows[key] = Math.round(Math.min(100, used / max * 100) * 10) / 10;
		const reset = typeof limit?.reset_at === "string" ? Date.parse(limit.reset_at) : NaN;
		if (Number.isFinite(reset) && reset >= 0) resets[key] = reset;
	}
	if (!Object.keys(windows).length) throw new Error("codex-lb reported no quota limits (limits may be unset or hidden)");
	return { windows, resets, plan: "codex-lb" };
}

export function codexLbUsageUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("codex-lb requires an HTTP(S) base URL without credentials, query, or fragment");
	}
	const base = url.pathname.replace(/\/+$/, "");
	if (!base.endsWith("/v1")) throw new Error("codex-lb base URL must end in /v1");
	url.pathname = `${base}/usage`;
	return url.toString();
}

export function createCodexLbCfg(id: string): ProviderCfg {
	return {
		id,
		// Provider IDs can point at different hosts/keys in different sessions.
		// Keep proxy quotas session-local rather than sharing the ID-only disk cache.
		sharedCache: false,
		async fetchUsage(signal, ctx) {
			const registry = ctx?.modelRegistry;
			const model = ctx?.model?.provider === id ? ctx.model : registry?.getAll().find((m) => m.provider === id);
			if (!registry || !model) throw new MissingCredentialError(`no configured model for ${id}`);
			const auth = await registry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(`Unable to resolve credentials for ${id}; check provider configuration`);
			const headers = new Headers({ Accept: "application/json" });
			if (auth.apiKey) headers.set("Authorization", `Bearer ${auth.apiKey}`);
			for (const [name, value] of Object.entries(auth.headers ?? {})) {
				if (value === null) headers.delete(name);
				else headers.set(name, value);
			}
			if (!headers.has("Authorization")) throw new MissingCredentialError(`no API key for ${id}`);
			const res = await fetch(codexLbUsageUrl(auth.baseUrl ?? model.baseUrl), {
				headers,
				redirect: "error",
				signal: anySignal(signal, AbortSignal.timeout(10_000)),
			});
			if (!res.ok) throw await usageHttpError(res, id, [
				auth.apiKey ?? "", headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "", ...headers.values(),
			]);
			return parseCodexLbUsage(await res.json());
		},
		render: codexCfg.render,
	};
}

const RETRYABLE_ANTIGRAVITY_STATUSES = new Set([
	403,
	404,
	429,
	500,
	502,
	503,
	504,
]);

/** Match Antigravity's endpoint order so quota reads use the same pool. */
export function antigravityEndpointCandidates(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const explicit = env.ANTIGRAVITY_BASE_URL?.trim();
	return explicit ? [explicit] : [...ENDPOINT_FALLBACKS];
}

interface CachedAntigravityToken {
	token: string;
	expiresAt: number;
	refreshToken: string;
}
let cachedAntigravityToken: CachedAntigravityToken | undefined;
const cachedAntigravityTiers = new Map<string, { plan: string; cachedAt: number }>();
const TIER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function refreshAntigravityToken(
	refreshToken: string,
	signal?: AbortSignal,
): Promise<string> {
	if (
		cachedAntigravityToken &&
		cachedAntigravityToken.refreshToken === refreshToken &&
		Date.now() < cachedAntigravityToken.expiresAt
	) {
		return cachedAntigravityToken.token;
	}
	const res = await undiciFetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}).toString(),
		dispatcher: ipv4Dispatcher,
		signal: anySignal(signal, AbortSignal.timeout(10_000)),
	});
	if (!res.ok) {
		const error = await usageHttpError(res as unknown as Response, "antigravity", [refreshToken]);
		throw new Error(`token refresh ${error.message}`);
	}
	const data = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
	if (typeof data.access_token !== "string" || !data.access_token) {
		throw new Error("token refresh response did not include an access token");
	}
	const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
	cachedAntigravityToken = {
		token: data.access_token,
		expiresAt: Date.now() + Math.max(60_000, (expiresInSec - 60) * 1000),
		refreshToken,
	};
	return data.access_token;
}

/** Antigravity (Google Cloud Code Assist): 5h & weekly pools for Gemini and Claude/GPT models. */
export const antigravityCfg: ProviderCfg = {
	id: "antigravity",
	async fetchUsage(signal?: AbortSignal) {
		let refreshToken: string | undefined;
		const endpoints = antigravityEndpointCandidates();
		const baseHeaders: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
			// The legacy IDE UA ("antigravity/1.15.8 windows/amd64") gets a quota
			// summary with only the 3p-* (Claude/GPT) buckets; the CLI UA also
			// receives the gemini-5h / gemini-weekly buckets.
			"User-Agent":
				process.env.ANTIGRAVITY_USER_AGENT ||
				"antigravity/cli/1.4.2 (aidev_client; os_type=linux; arch=amd64; cl=1001591392; auth_method=consumer)",
			"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
			"Client-Metadata": JSON.stringify({
				ideType: "ANTIGRAVITY",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
			}),
		};

		async function queryQuota(
			token: string,
		): Promise<{ response: Response; endpoint: string }> {
			let lastError: unknown;
			for (const endpoint of endpoints) {
				try {
					const response = await fetch(
						`${endpoint}/v1internal:retrieveUserQuotaSummary`,
						{
							method: "POST",
							headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
							body: JSON.stringify({}),
							signal: anySignal(signal, AbortSignal.timeout(10_000)),
						},
					);
					if (response.ok || !RETRYABLE_ANTIGRAVITY_STATUSES.has(response.status)) {
						return { response, endpoint };
					}
					lastError = await usageHttpError(response, "antigravity", [token, refreshToken ?? ""]);
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError instanceof Error
				? lastError
				: new Error("all Antigravity quota endpoints failed");
		}

		async function queryPlan(token: string, endpoint: string): Promise<string | undefined> {
			const cached = cachedAntigravityTiers.get(token);
			if (cached && Date.now() - cached.cachedAt < TIER_CACHE_TTL_MS) return cached.plan;
			try {
				const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
					method: "POST",
					headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
					body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
					signal: anySignal(signal, AbortSignal.timeout(10_000)),
				});
				if (!response.ok) {
					await response.body?.cancel().catch(() => undefined);
					return undefined;
				}
				const data = await response.json() as { paidTier?: { name?: string }; currentTier?: { name?: string } };
				const name = data.paidTier?.name || data.currentTier?.name;
				const plan = name === "Antigravity" ? "Free" : name?.replace(/^Google AI\s*/i, "");
				if (plan) {
					for (const [key, entry] of cachedAntigravityTiers) {
						if (Date.now() - entry.cachedAt >= TIER_CACHE_TTL_MS) cachedAntigravityTiers.delete(key);
					}
					cachedAntigravityTiers.set(token, { plan, cachedAt: Date.now() });
				}
				return plan;
			} catch {
				return undefined; // Tier lookup must not hide valid quota data.
			}
		}

		function parseQuotaBuckets(quotaJson: unknown): { windows: Record<string, number>; resets: Record<string, number> } {
			const record = asRecord(quotaJson);
			const groups = Array.isArray(record?.groups) ? (record.groups as Array<Record<string, unknown>>) : [];
			const windows: Record<string, number> = {};
			const resets: Record<string, number> = {};
			for (const group of groups) {
				const buckets = Array.isArray(group?.buckets) ? (group.buckets as Array<Record<string, unknown>>) : [];
				for (const b of buckets) {
					const k = typeof b.bucketId === "string" ? b.bucketId : typeof b.window === "string" ? b.window : undefined;
					if (!k) continue;
					if (typeof b.remainingFraction === "number" && Number.isFinite(b.remainingFraction)) {
						windows[k] = Math.round((1 - Math.min(1, Math.max(0, b.remainingFraction))) * 100);
					}
					if (typeof b.resetTime === "string") {
						const r = Date.parse(b.resetTime);
						if (!Number.isNaN(r)) resets[k] = r;
					}
				}
			}
			return { windows, resets };
		}

		// Multi-account store support: query all linked accounts if multiple exist
		const agAccountsPath = path.join(os.homedir(), ".pi", "agent", "antigravity-accounts.json");
		let agAccountsFile: {
			activeAccountId?: string;
			accounts?: Record<string, { accountId?: string; email?: string; access?: string; refresh?: string; expires?: number; cooldownUntil?: number }>;
		} | undefined;
		try {
			if (fs.existsSync(agAccountsPath)) {
				agAccountsFile = JSON.parse(fs.readFileSync(agAccountsPath, "utf8"));
			}
		} catch {}

		if (agAccountsFile?.accounts && Object.keys(agAccountsFile.accounts).length > 1) {
			const activeId = agAccountsFile.activeAccountId;
			const accountEntries = Object.entries(agAccountsFile.accounts);
			const accountItems = (
				await Promise.all(
					accountEntries.map(async ([key, acc]) => {
						let tok = acc.access;
						if (!tok || (typeof acc.expires === "number" && Date.now() >= acc.expires - 60_000)) {
							if (acc.refresh) {
								try {
									tok = await refreshAntigravityToken(acc.refresh, signal);
								} catch {}
							}
						}
						if (!tok) return undefined;
						try {
							const qRes = await queryQuota(tok);
							if (!qRes.response.ok) return undefined;
							const quotaJson = await qRes.response.json();
							const { windows: accWindows, resets: accResets } = parseQuotaBuckets(quotaJson);
							if (Object.keys(accWindows).length === 0) return undefined;
							const isAct = acc.accountId === activeId || acc.email === activeId || key === activeId;
							const isCool = Boolean(acc.cooldownUntil && acc.cooldownUntil > Date.now());
							return {
								id: acc.email || acc.accountId || key,
								active: isAct,
								cooldown: isCool,
								plan: await queryPlan(tok, qRes.endpoint),
								windows: accWindows,
								resets: accResets,
							};
						} catch {
							return undefined;
						}
					}),
				)
			).filter((a): a is NonNullable<typeof a> => Boolean(a));

			if (accountItems.length > 0) {
				const primary = accountItems.find((a) => a.active) || accountItems[0];
				return {
					windows: primary.windows,
					plan: primary.plan,
					resets: primary.resets,
					accounts: accountItems,
				};
			}
		}

		// Single-account fallback flow
		const fromEnv =
			process.env.ANTIGRAVITY_TOKEN || process.env.ANTIGRAVITY_API_KEY;
		let access = fromEnv?.trim();
		let expires = 0;

		if (!access) {
			const cred = readStoredCredential("antigravity");
			if (cred && cred.type === "oauth") {
				access = cred.access;
				refreshToken = cred.refresh;
				expires = typeof cred.expires === "number" ? cred.expires : 0;
			}
		}

		if (!access && !refreshToken)
			throw new MissingCredentialError("no OAuth token or API key for antigravity");

		if (
			refreshToken &&
			(!access || (expires > 0 && Date.now() >= expires - 60_000))
		) {
			try {
				access = await refreshAntigravityToken(refreshToken, signal);
			} catch (e) {
				if (!access) throw e;
			}
		}
		if (!access) throw new MissingCredentialError("antigravity access token is unavailable");

		let quotaResult = await queryQuota(access);
		if (quotaResult.response.status === 401 && refreshToken) {
			await quotaResult.response.body?.cancel().catch(() => undefined);
			cachedAntigravityToken = undefined;
			access = await refreshAntigravityToken(refreshToken, signal);
			quotaResult = await queryQuota(access);
		}
		const resQuota = quotaResult.response;
		const baseUrl = quotaResult.endpoint;

		if (!resQuota.ok) {
			throw await usageHttpError(resQuota, "antigravity", [access, refreshToken ?? ""]);
		}
		const quotaJson = await resQuota.json();
		const { windows, resets } = parseQuotaBuckets(quotaJson);

		if (Object.keys(windows).length === 0) throw new Error("no usage data");

		const plan = await queryPlan(access, baseUrl);

		return { windows, plan, resets };
	},
	render(data, theme, modelId, style = "bars") {
		const w = data.windows;
		const isClaude = modelId ? /claude/i.test(modelId) : false;
		const isGpt = modelId ? /gpt/i.test(modelId) : false;
		const is3p = isClaude || isGpt || (modelId ? /3p/i.test(modelId) : false);

		let bucketKeys: Array<[string, string]>;

		if (is3p) {
			bucketKeys = [
				["3p-5h", "5h"],
				["3p-weekly", "W"],
			];
		} else {
			bucketKeys = [
				["gemini-5h", "5h"],
				["gemini-weekly", "W"],
			];
		}

		const hasSelectedData = bucketKeys.some(([k]) => typeof w[k] === "number");
		if (!hasSelectedData) {
			// Model's pool is unknown — show every bucket with disambiguating labels.
			bucketKeys = [
				["gemini-5h", "G-5h"],
				["gemini-weekly", "G-W"],
				["3p-5h", "3P-5h"],
				["3p-weekly", "3P-W"],
			];
		}

		const parts: string[] = [];
		for (const [k, label] of bucketKeys) {
			const val = w[k];
			if (typeof val === "number") {
				parts.push(labeledWindow(label, val, data.resets, k, theme, style));
			}
		}

		if (parts.length === 0) return "";
		return joinParts(parts, theme);
	},
};

/** Claude Code CLI: rate limit windows (5h, 7d/weekly) captured from CLI execution. */
export const claudeCliCfg: ProviderCfg = {
	id: "claude-cli",
	async fetchUsage(signal) {
		let plan: string | undefined;
		let token: string | undefined;
		try {
			const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
			const oauth = JSON.parse(await fs.promises.readFile(credPath, "utf8"))?.claudeAiOauth;
			if (oauth?.subscriptionType) plan = String(oauth.subscriptionType);
			// The CLI owns refresh; an expired token just falls back to the cache.
			if (typeof oauth?.accessToken === "string" && !(oauth.expiresAt < Date.now())) {
				token = oauth.accessToken;
			}
		} catch {
			// credentials not on disk or unreadable
		}

		// Same endpoint Claude Code's own /usage reads; utilization is 0-100.
		if (token) {
			const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
				headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
				signal,
			});
			if (!res.ok) throw await usageHttpError(res, "claude-cli", [token]);
			const json = asRecord(await res.json());
			const windows: Record<string, number> = {};
			const resets: Record<string, number> = {};
			for (const [src, key] of [
				["five_hour", "5h"],
				["seven_day", "7d"],
				["seven_day_opus", "opus"],
				["seven_day_sonnet", "sonnet"],
			] as const) {
				const win = asRecord(json?.[src]);
				if (typeof win?.utilization !== "number") continue;
				windows[key] = Math.round(win.utilization);
				const at = typeof win.resets_at === "string" ? Date.parse(win.resets_at) : NaN;
				if (Number.isFinite(at)) resets[key] = at;
			}
			return { windows, resets, plan };
		}

		const cached = (await diskCache.read())["claude-cli"]?.data;
		if (cached && Object.keys(cached.windows || {}).length > 0) {
			return {
				...cached,
				plan: plan ?? cached.plan,
			};
		}

		if (plan) {
			return {
				windows: {},
				plan,
			};
		}

		throw new MissingCredentialError("no Claude Code credentials in ~/.claude/.credentials.json");
	},
	render(data, theme, _modelId, style: UsageStyle = "bars") {
		const w = data.windows;
		if (!w || Object.keys(w).length === 0) return "";
		const parts: string[] = [];
		for (const [k, label] of [
			["5h", "5h"],
			["7d", "7d"],
			["opus", "opus"],
			["sonnet", "sonnet"],
		] as const) {
			const val = w[k];
			if (typeof val === "number") {
				parts.push(labeledWindow(label, val, data.resets, k, theme, style));
			}
		}
		if (parts.length === 0) return "";
		return joinParts(parts, theme);
	},
};

/**
 * Every usage provider this extension can query, in display order. `/usage
 * refresh` fans out over this list unless a narrower target is given.
 */
export const usageProviderCfgs: readonly ProviderCfg[] = [
	opencodeCfg,
	codexCfg,
	codexPoolCfg,
	alpakyrosPoolCfg,
	antigravityCfg,
	claudeCliCfg,
	deepseekCfg,
];

/** Unambiguous short names accepted as `/usage refresh <target>` aliases. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
	opencode: "opencode-go",
	"opencode-zen": "opencode-go",
	zen: "opencode-go",
	codex: "openai-codex",
	openai: "openai-codex",
	antigravity: "antigravity",
	google: "antigravity",
	claude: "claude-cli",
	"claude-cli": "claude-cli",
	deepseek: "deepseek",
};

/**
 * Resolve a `/usage refresh` target. Empty/`active` means the current provider,
 * `all` explicitly selects every configured usage provider, and anything
 * else must match a provider id or one of its aliases. Returns `undefined` for
 * an unknown target so the caller can warn without issuing a request.
 */
export function resolveRefreshTargets(
	arg: string,
	cfgs: readonly ProviderCfg[],
	activeProviderId?: string,
): ProviderCfg[] | undefined {
	const target = arg.trim().toLowerCase();
	if (target === "all") return [...cfgs];
	if (!target || target === "active") {
		const active = activeProviderId
			? cfgs.find((c) => c.id.toLowerCase() === activeProviderId.toLowerCase())
			: undefined;
		return active ? [active] : undefined;
	}
	const exact = cfgs.find((c) => c.id.toLowerCase() === target);
	if (exact) return [exact];
	const aliased = PROVIDER_ALIASES[target];
	if (!aliased) return undefined;
	const match = cfgs.find((c) => c.id === aliased);
	return match ? [match] : undefined;
}

/** Human-readable summary of a `/usage refresh` fan-out. */
export function formatRefreshNotice(results: readonly RefreshResult[]): string {
	if (results.length === 0) return "No usage providers to refresh";
	if (results.length === 1) {
		const { id, outcome, error } = results[0];
		switch (outcome) {
			case "fetched":
				return `Usage refreshed for ${id}`;
			case "cached":
				return `Usage refresh finished from cache for ${id}`;
			case "skipped":
				return `Usage refresh skipped for ${id} (no credentials)`;
			default:
				return `Usage refresh failed for ${id}${error ? `: ${error}` : ""}`;
		}
	}
	const idsWith = (outcome: RefreshOutcome) =>
		results.filter((r) => r.outcome === outcome).map((r) => r.id);
	const fetched = idsWith("fetched");
	const cached = idsWith("cached");
	const skipped = idsWith("skipped");
	const failed = results.filter((r) => r.outcome === "failed")
		.map((r) => `${r.id}${r.error ? ` (${r.error})` : ""}`);
	const parts: string[] = [];
	if (fetched.length === results.length) {
		parts.push(`Usage refreshed for all ${results.length} providers (${fetched.join(", ")})`);
	} else if (fetched.length > 0) {
		parts.push(`Usage refreshed for ${fetched.join(", ")}`);
	} else {
		parts.push("No usage data refreshed");
	}
	if (cached.length > 0) parts.push(`from cache: ${cached.join(", ")}`);
	if (skipped.length > 0) parts.push(`no credentials: ${skipped.join(", ")}`);
	if (failed.length > 0) parts.push(`failed: ${failed.join(", ")}`);
	return parts.join(" · ");
}

export default function (pi: ExtensionAPI) {
	const cache = new Map<string, ProviderState>();
	let currentCtx: StatusCtx | undefined;
	let selectedPoolAccount: string | undefined;
	const onPoolAccountSelected = (event: unknown) => {
		const id = asRecord(event)?.id;
		if (typeof id !== "string") return;
		selectedPoolAccount = id;
		const poolData = cache.get("codex-pool")?.lastData;
		if (poolData?.accounts) {
			for (const account of poolData.accounts) account.active = account.id === id;
		}
		const ui = currentCtx ? safeUi(currentCtx) : undefined;
		const data = cache.get("codex-pool")?.lastData;
		if (ui && data && mode !== "off") renderUi(ui, "codex-pool", renderCodexPoolFooter(data, ui.theme, id, mode));
	};
	let unsubscribePool = pi.events?.on("codex-pool:account-selected", onPoolAccountSelected);
	pi.on("session_start", () => {
		selectedPoolAccount = undefined;
		unsubscribePool?.();
		unsubscribePool = pi.events?.on("codex-pool:account-selected", onPoolAccountSelected);
	});
	pi.on("session_shutdown", () => { unsubscribePool?.(); });
	const prefs = loadPrefs();
	const cfgs = [...usageProviderCfgs, ...(prefs.codexLbProviders ?? [])
		.filter((id) => !usageProviderCfgs.some((cfg) => cfg.id === id))
		.map(createCodexLbCfg)];
	let mode: UsageMode = prefs.mode;

	function renderUi(
		ui: StatusCtx["ui"] | undefined,
		providerId: string,
		text: string | undefined,
	): void {
		if (!ui) return;
		// The usage widget belongs to the active provider only: a fan-out
		// refresh must not leave widgets behind for providers we are not using.
		if (text !== undefined) {
			const activeProvider = currentCtx ? safeModel(currentCtx)?.provider : undefined;
			if (activeProvider !== providerId) return;
		}
		try {
			// Older/headless UI adapters may expose only setStatus.
			if (!ui.setWidget) {
				ui.setStatus(providerId, text);
				return;
			}
			ui.setStatus(providerId, undefined);
			const widgetKey = `subscription-usage:${providerId}`;
			if (text === undefined) {
				ui.setWidget(widgetKey, undefined, { placement: "belowEditor" });
				return;
			}
			ui.setWidget(widgetKey, (_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					if (width < 1 || mode === "off") return [];
					const model = currentCtx ? safeModel(currentCtx) : undefined;
					if (model?.provider !== providerId) return [];
					const cfg = cfgs.find((c) => c.id === providerId);
					const state = cache.get(providerId);
					if (!cfg || !state?.lastData) return wrapTextWithAnsi(text, width);
					const data = state.lastData;
					const render = (style: UsageStyle) => {
						const value = cfg.id === "codex-pool" ? renderCodexPoolFooter(data, theme, selectedPoolAccount, style) : cfg.render(data, theme, model.id, style);
						return state.failStreak > 0 ? theme.fg("warning", `${value} ⚠`) : value;
					};
					const full = render(mode);
					if (visibleWidth(full) <= width) return [full];
					let compact = render("percent");
					if (data.plan === "codex-lb") {
						compact = `Used: ${compact.replace(/ used(?= )/g, "")}`;
					}
					return wrapTextWithAnsi(compact, width);
				},
			}), { placement: "belowEditor" });
		} catch {
			// The session can be replaced between safeUi() and this write.
		}
	}

	/** Render `data` for a provider in the current style. */
	function renderText(
		cfg: ProviderCfg,
		data: UsageData,
		ui: StatusCtx["ui"],
		modelId?: string,
	): string {
		if (mode === "off") return "";
		return (cfg.id === "codex-pool" ? renderCodexPoolFooter(data, ui.theme, selectedPoolAccount, mode) : cfg.render(data, ui.theme, modelId, mode)) || `${cfg.id}: no data`;
	}

	function freshState(): ProviderState {
		return {
			lastFetch: 0,
			lastAttempt: 0,
			lastText: undefined,
			lastData: undefined,
			failStreak: 0,
			timer: undefined,
			timerDeadline: undefined,
			inFlight: undefined,
			requestId: 0,
			abortController: undefined,
		};
	}

	let cacheSyncTimer: ReturnType<typeof setTimeout> | undefined;
	let cacheWatcherActive = false;

	async function syncFromDisk(): Promise<void> {
		const ctx = currentCtx;
		if (!ctx || mode === "off") return;
		const ui = safeUi(ctx);
		if (!ui) return;
		const model = safeModel(ctx);
		const activeProvider = model?.provider;
		if (!activeProvider) return;
		const cfg = cfgs.find((c) => c.id === activeProvider);
		if (!cfg || cfg.sharedCache === false) return;

		const state = cache.get(cfg.id);
		if (!state) return;
		const requestId = state.requestId;
		const disk = (await diskCache.read())[cfg.id];
		// A delayed disk read must not revive a cleared provider or overwrite
		// a newer request after a model switch, hide, or session shutdown.
		if (cache.get(cfg.id) !== state || state.requestId !== requestId) return;
		if (!disk?.data || !Number.isFinite(disk.fetchedAt)) return;
		if (disk.fetchedAt > state.lastFetch) {
			state.lastFetch = disk.fetchedAt;
			state.lastData = disk.data;
			state.failStreak = 0;
			cache.set(cfg.id, state);
			state.lastText = renderText(cfg, disk.data, ui, model?.id);
			renderUi(ui, cfg.id, state.lastText);
			arm(cfg, ctx, nextDelay(state, Date.now(), model?.id, cfg.id));
		}
	}

	function scheduleDiskSync(): void {
		if (cacheSyncTimer) return;
		cacheSyncTimer = setTimeout(() => {
			cacheSyncTimer = undefined;
			void (async () => {
				try {
					await syncFromDisk();
				} catch (error) {
					console.error("[subscription-usage] cache sync failed:", error);
				}
			})();
		}, 100);
		cacheSyncTimer.unref?.();
	}

	function onDiskCacheChange(curr: fs.Stats, prev: fs.Stats): void {
		if (curr.mtimeMs !== prev.mtimeMs) scheduleDiskSync();
	}

	function startDiskCacheWatcher(): void {
		if (cacheWatcherActive) return;
		try {
			fs.watchFile(
				CACHE_PATH,
				{ interval: 1000, persistent: false },
				onDiskCacheChange,
			);
			cacheWatcherActive = true;
		} catch {
			// Ignore watch error if the cache path is not accessible yet.
		}
	}

	function stopDiskCacheWatcher(): void {
		if (!cacheWatcherActive) return;
		try {
			fs.unwatchFile(CACHE_PATH, onDiskCacheChange);
		} catch {
			// Ignore unwatch failure during shutdown.
		}
		cacheWatcherActive = false;
		if (cacheSyncTimer) clearTimeout(cacheSyncTimer);
		cacheSyncTimer = undefined;
	}

	/**
	 * Return ctx.ui, or undefined when the session ctx is stale — i.e. the
	 * session was replaced or reloaded while we were awaiting a fetch. UI
	 * writes are dropped silently in that case instead of throwing the
	 * "extension ctx is stale" error (which used to escape as an
	 * uncaughtException and kill pi).
	 */
	function safeUi(ctx: StatusCtx): StatusCtx["ui"] | undefined {
		try {
			const ui = ctx.ui;
			void ui.theme;
			return ui;
		} catch {
			return undefined;
		}
	}

	function safeModel(ctx: StatusCtx): StatusCtx["model"] | undefined {
		try {
			const model = ctx.model;
			if (model) {
				void model.provider;
				void model.id;
			}
			return model;
		} catch {
			return undefined;
		}
	}

	/**
	 * Next delay until the next fetch: exponential backoff while the API is
	 * failing; otherwise wake right after the nearest reset flips, or fall
	 * back to the idle interval.
	 */
	function nextDelay(
		state: ProviderState,
		now: number,
		modelId?: string,
		providerId?: string,
	): number {
		if (state.failStreak > 0) {
			const backoff = Math.min(
				ERROR_BACKOFF_BASE_MS * 2 ** (state.failStreak - 1),
				ERROR_BACKOFF_CAP_MS,
			);
			return jitter(backoff);
		}
		const reset = earliestReset(state.lastData, modelId, providerId, now);
		if (reset !== undefined) {
			const dt = reset - now;
			if (dt <= 0) {
				if (state.lastFetch >= reset) {
					return jitter(INTERVAL_MS);
				}
				return jitter(Math.min(COOLDOWN_MS, INTERVAL_MS));
			}
			if (dt < INTERVAL_MS + RESET_CATCH_DELAY_MS) {
				return Math.max(dt + RESET_CATCH_DELAY_MS, MIN_FETCH_GAP_MS);
			}
		}
		return jitter(INTERVAL_MS);
	}

	// `hard` (manual /usage refresh) also bypasses the MIN_FETCH_GAP_MS
	// burst guard, so one keystroke always performs a live provider request.
	async function refresh(
		cfg: ProviderCfg,
		ctx: StatusCtx,
		force: boolean,
		hard = false,
		scheduled = false,
	): Promise<RefreshOutcome> {
		const state = cache.get(cfg.id) ?? freshState();
		cache.set(cfg.id, state);
		if (state.inFlight && !hard) return state.inFlight;
		const requestId = state.requestId + 1;
		state.requestId = requestId;
		const isCurrentRequest = (): boolean =>
			cache.get(cfg.id) === state && state.requestId === requestId;

		state.abortController?.abort();
		const ac = new AbortController();
		state.abortController = ac;

		const request = (async (): Promise<RefreshOutcome> => {
			const now = Date.now();
			const model = safeModel(ctx);

			// Sync with disk cache if another session fetched newer data.
			const disk = cfg.sharedCache === false ? undefined : (await diskCache.read())[cfg.id];
			if (!isCurrentRequest()) return "cached";
			if (!disk?.data || !Number.isFinite(disk.fetchedAt)) {
				// No usable shared data; continue to the provider request.
			} else if (disk.fetchedAt > state.lastFetch) {
				state.lastFetch = disk.fetchedAt;
				state.lastData = disk.data;
				state.failStreak = 0;
			}

			// Event pokes (agent_settled) skip when we fetched moments ago, or
			// while the API is failing and no reset is about to flip. Forced
			// refetches (session start, model switch) always hit the API.
			const reset = earliestReset(state.lastData, model?.id, cfg.id, now);
			const resetSoon = reset !== undefined && reset - now < COOLDOWN_MS;
			if (
				!force &&
				!scheduled &&
				state.lastText !== undefined &&
				(now - state.lastAttempt < COOLDOWN_MS ||
					(state.failStreak > 0 && !resetSoon))
			) {
				const ui = safeUi(ctx);
				if (ui && state.lastData) {
					state.lastText = renderText(cfg, state.lastData, ui, model?.id);
				}
				renderUi(ui, cfg.id, state.lastText);
				return "cached";
			}

			// Even on forced poke, if disk was updated within MIN_FETCH_GAP_MS
			// (e.g. another session just fetched 2s ago), reuse it to avoid a
			// duplicate burst request. Manual /usage refresh (hard) skips this.
			if (!hard && now - state.lastFetch < MIN_FETCH_GAP_MS && state.lastData) {
				const ui = safeUi(ctx);
				if (ui) {
					state.lastText = renderText(cfg, state.lastData, ui, model?.id);
					renderUi(ui, cfg.id, state.lastText);
				}
				return "cached";
			}

			state.lastAttempt = now;
			state.lastError = undefined;
			try {
				const data = normalizeUsageData(await cfg.fetchUsage(ac.signal, ctx));
				if (!data) throw new Error("provider returned no valid usage data");
				const ui = safeUi(ctx);
				if (!ui || !isCurrentRequest()) return "cached";
				state.lastFetch = now;
				state.failStreak = 0;
				state.lastData = data;
				state.lastText = renderText(cfg, data, ui, model?.id);
				renderUi(ui, cfg.id, state.lastText);
				if (cfg.sharedCache !== false) await diskCache.write(cfg.id, data);
				return "fetched";
			} catch (err) {
				const ui = safeUi(ctx);
				if (!ui || !isCurrentRequest()) return "cached";
				if (err instanceof MissingCredentialError) {
					// No credential for this account: nothing was sent to the API, so
					// this is availability, not failure — no backoff, no error log.
					state.lastText = state.lastData
						? renderText(cfg, state.lastData, ui, model?.id)
						: ui.theme.fg("warning", `${cfg.id}: no key`);
					renderUi(ui, cfg.id, state.lastText);
					return "skipped";
				}
				state.failStreak += 1;
				state.lastError = err instanceof Error ? err.message : String(err);
				console.error(
					`[${cfg.id}-usage] fetch failed (${state.failStreak}×): ` +
						(err instanceof Error ? err.message : String(err)),
				);
				if (state.lastData) {
					const base = renderText(cfg, state.lastData, ui, model?.id);
					state.lastText = ui.theme.fg("warning", `${base} ⚠`);
					renderUi(ui, cfg.id, state.lastText);
				} else {
					state.lastText = ui.theme.fg("error", `${cfg.id}: err`);
					renderUi(ui, cfg.id, state.lastText);
				}
				return "failed";
			}
		})();
		state.inFlight = request;
		try {
			return await request;
		} finally {
			if (state.abortController === ac) state.abortController = undefined;
			if (state.inFlight === request) state.inFlight = undefined;
		}
	}

	/** (Re)arm the next scheduled fetch with a delay computed from the last outcome. */
	function arm(cfg: ProviderCfg, ctx: StatusCtx, delayMs: number) {
		const state = cache.get(cfg.id) ?? freshState();
		if (state.timer) clearTimeout(state.timer);
		cache.set(cfg.id, state);
		state.timerDeadline = Date.now() + delayMs;
		state.timer = setTimeout(() => {
			state.timer = undefined;
			state.timerDeadline = undefined;
			void (async () => {
				if (!safeUi(ctx) || cache.get(cfg.id) !== state) return;
				await refresh(cfg, ctx, false, false, true);
				if (!safeUi(ctx) || cache.get(cfg.id) !== state) return;
				const model = safeModel(ctx);
				arm(cfg, ctx, nextDelay(state, Date.now(), model?.id, cfg.id));
			})();
		}, delayMs);
		state.timer.unref?.();
	}

	/** Immediate refresh + rearm from the fresh outcome (used by events). */
	function poke(cfg: ProviderCfg, ctx: StatusCtx, force: boolean) {
		void (async () => {
			if (!safeUi(ctx)) return;
			const outcome = await refresh(cfg, ctx, force);
			const s = cache.get(cfg.id);
			const model = safeModel(ctx);
			if (s && safeUi(ctx)) {
				if (outcome === "fetched" || !s.timer) {
					arm(cfg, ctx, nextDelay(s, Date.now(), model?.id, cfg.id));
				}
			}
		})();
	}

	function clear(ctx: StatusCtx, key: string) {
		const state = cache.get(key);
		if (state?.timer) clearTimeout(state.timer);
		state?.abortController?.abort();
		cache.delete(key);
		renderUi(safeUi(ctx), key, undefined);
	}

	/** Route to the right provider config for the active model. */
	function route(ctx: StatusCtx, force: boolean) {
		currentCtx = ctx;
		pi.events?.emit("codex-pool:request-account", {});
		if (mode === "off") {
			stopDiskCacheWatcher();
			return;
		}
		const provider = safeModel(ctx)?.provider;
		const active = cfgs.find((c) => c.id === provider);
		for (const c of cfgs) {
			if (c !== active) clear(ctx, c.id);
		}
		if (active) {
			if (active.sharedCache === false) {
				stopDiskCacheWatcher();
				if (force) clear(ctx, active.id);
			} else startDiskCacheWatcher();
			poke(active, ctx, force);
		} else {
			stopDiskCacheWatcher();
		}
	}

	/**
	 * Shared `/usage` subcommand handlers — the single `usage` command
	 * registered below dispatches to these, so every usage control lives
	 * under one `/usage` command.
	 */
	type UsageCmdCtx = Parameters<
		Parameters<typeof pi.registerCommand>[1]["handler"]
	>[1];

	/** `/usage toggle [bars|percent|off]` — cycle the usage style or set it directly. */
	async function handleUsageToggle(args: string, ctx: UsageCmdCtx): Promise<void> {
		let next: UsageMode;
		const arg = args.trim().toLowerCase();
		if (arg) {
			const parsed = normalizeUsageMode(arg);
			if (!parsed) {
				ctx.ui.notify(
					`Unknown mode "${args.trim()}". Options: ${USAGE_MODES.join(", ")}`,
					"warning",
				);
				return;
			}
			next = parsed;
		} else {
			// Cycle: bars → percent → off → bars
			next = USAGE_MODES[(USAGE_MODES.indexOf(mode) + 1) % USAGE_MODES.length];
		}

		mode = next;
		await savePrefs({ ...prefs, mode });

		if (next === "off") {
			stopDiskCacheWatcher();
			// Hide: drop statuses and stop every timer/fetch for this session.
			for (const c of cfgs) clear(ctx, c.id);
			ctx.ui.notify("Subscription usage hidden (/usage toggle restores it)", "info");
			return;
		}

		// Re-render from cached data so the widget updates immediately.
		const model = safeModel(ctx);
		const cfg = cfgs.find((c) => c.id === model?.provider);
		const ui = safeUi(ctx);
		const state = cfg ? cache.get(cfg.id) : undefined;
		if (cfg && ui && state?.lastData) {
			state.lastText = renderText(cfg, state.lastData, ui, model?.id);
			renderUi(ui, cfg.id, state.lastText);
			// Leaving "off" killed this provider's timer — re-arm it.
			if (!state.timer)
				arm(cfg, ctx, nextDelay(state, Date.now(), model?.id, cfg.id));
		} else if (cfg && ui) {
			// Nothing usable cached (e.g. first reveal after hiding) — fetch now.
			poke(cfg, ctx, true);
		}
		ctx.ui.notify(`Subscription usage style: ${next}`, "info");
	}

	/**
	 * `/usage refresh [active|<provider>|all]` — force a live refetch for the
	 * active provider by default, or the named/all providers, bypassing the
	 * cooldown and burst guards. Useful when the source API lags (e.g.
	 * Antigravity quota summary right after a reset) and you want to rule out
	 * client-side staleness in one keystroke.
	 */
	async function handleUsageRefresh(args: string, ctx: UsageCmdCtx): Promise<void> {
		if (mode === "off") {
			ctx.ui.notify(
				"Subscription usage is hidden; use /usage toggle to enable refreshes",
				"info",
			);
			return;
		}
		const targets = resolveRefreshTargets(args, cfgs, safeModel(ctx)?.provider);
		if (!targets) {
			if (!args.trim() || args.trim().toLowerCase() === "active") {
				ctx.ui.notify(`Usage is not configured for active provider "${safeModel(ctx)?.provider ?? "none"}". For codex-lb, add its provider ID to codexLbProviders in subscription-usage-prefs.json and reload. Use /usage refresh all only to check other providers.`, "warning");
				return;
			}
			ctx.ui.notify(
				`Unknown usage provider "${args.trim()}". Known: ${cfgs.map((c) => c.id).join(", ")}` +
				` (or "all"/"active")`,
				"warning",
			);
			return;
		}
		// Settle every target so one slow or failing provider cannot hide the
		// outcome of the others. `refresh()` reports rather than throws.
		const settled = await Promise.allSettled(
			targets.map(async (cfg): Promise<RefreshResult> => ({
				id: cfg.id,
				outcome: await refresh(cfg, ctx, true, true),
				error: cache.get(cfg.id)?.lastError,
			})),
		);
		const results: RefreshResult[] = settled.map((entry, index) =>
			entry.status === "fulfilled"
				? entry.value
				: { id: targets[index].id, outcome: "failed" as const },
		);
		// Only the provider active *now* owns the usage widget and the wake timer: a
		// fan-out must not leave stale widgets or polling loops behind.
		const current = safeModel(ctx);
		const activeCfg = cfgs.find((c) => c.id === current?.provider);
		const state = activeCfg ? cache.get(activeCfg.id) : undefined;
		if (activeCfg && state && safeUi(ctx))
			arm(activeCfg, ctx, nextDelay(state, Date.now(), current?.id, activeCfg.id));
		ctx.ui.notify(formatRefreshNotice(results), results.some((r) => r.outcome === "failed") ? "warning" : "info");
	}

	/**
	 * Single `/usage` command: bare `/usage` shows the detailed readout;
	 * `/usage toggle [bars|percent|off]` cycles the usage style;
	 * `/usage refresh [active|<provider>|all]` force-refetches the active usage
	 * provider by default, or the explicitly named/all providers.
	 */
	pi.registerCommand("usage", {
		description: "Show subscription usage (/usage | toggle | refresh [all|<provider>|active])",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			const spaceIndex = trimmed.indexOf(" ");
			if (spaceIndex === -1) {
				const subcommands = [
					{ value: "toggle", label: "toggle", description: "Cycle usage style: bars → percent → off" },
					{ value: "refresh", label: "refresh", description: "Force-refresh the active provider (or name one/all)" },
					{ value: "help", label: "help", description: "Show usage help" },
				];
				const filtered = subcommands.filter((sub) =>
					sub.value.startsWith(trimmed.toLowerCase()),
				);
				return filtered.length > 0 ? filtered : null;
			}
			const sub = trimmed.slice(0, spaceIndex).toLowerCase();
			const rest = trimmed.slice(spaceIndex + 1).trimStart().toLowerCase();
			if (sub === "toggle") {
				const modes = ["bars", "percent", "off"].map((m) => ({
					value: `toggle ${m}`,
					label: `toggle ${m}`,
					description: `Set usage style to ${m}`,
				}));
				const filtered = modes.filter((item) => item.value.startsWith(`toggle ${rest}`));
				return filtered.length > 0 ? filtered : null;
			}
			if (sub === "refresh") {
				const targets = [
					{
						value: "refresh all",
						label: "refresh all",
						description: "Force-refresh every usage provider",
					},
					{
						value: "refresh active",
						label: "refresh active",
						description: "Force-refresh the active provider only",
					},
					...cfgs.map((c) => ({
						value: `refresh ${c.id}`,
						label: `refresh ${c.id}`,
						description: `Force-refresh ${c.id} only`,
					})),
				];
				const filtered = targets.filter((item) => item.value.startsWith(`refresh ${rest}`));
				return filtered.length > 0 ? filtered : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const spaceIndex = trimmed.indexOf(" ");
			const sub = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
			const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
			switch (sub) {
				case "":
					break;
				case "toggle":
					await handleUsageToggle(rest, ctx);
					return;
				case "refresh":
					await handleUsageRefresh(rest, ctx);
					return;
				case "help":
					ctx.ui.notify(
						[
							"Subscription usage commands:",
							"• /usage — detailed usage for all providers",
							"• /usage toggle [bars|percent|off] — cycle or set usage style",
							"• /usage refresh [active|<provider>|all] — force-refresh usage (default: active)",
						].join("\n"),
						"info",
					);
					return;
				default:
					ctx.ui.notify(
						`Unknown subcommand "${sub}". Usage: /usage | toggle [bars|percent|off] | refresh`,
						"warning",
					);
					return;
			}

			// Bare `/usage`: detailed readout for all providers.
			const model = safeModel(ctx);
			const activeCfg = cfgs.find((c) => c.id === model?.provider);
			// One live fetch for the active provider; the rest render from cache
			// so one keystroke never fans out to every API.
			// While hidden (`off`) there are no fetches at all; render from cache.
			if (activeCfg && mode !== "off") {
				try {
					await refresh(activeCfg, ctx, true, true);
				} catch {
					// refresh() already renders usage errors; details fall back to cache below.
				}
				const s = cache.get(activeCfg.id);
				const current = safeModel(ctx);
				if (s && safeUi(ctx))
					arm(activeCfg, ctx, nextDelay(s, Date.now(), current?.id, activeCfg.id));
			}
			const uiTheme = safeUi(ctx)?.theme;
			const hasColor = isColorTheme(uiTheme);
			let sharedDisk: Record<string, { data?: UsageData; fetchedAt?: number }> | undefined;
			const resolved = await Promise.all(
				cfgs.map(async (cfg) => {
					const state = cache.get(cfg.id);
					let data = state?.lastData;
					let fetchedAt = state?.lastFetch;
					if (!data && cfg.sharedCache !== false) {
						try {
							sharedDisk ??= await diskCache.read();
							const disk = sharedDisk[cfg.id];
							if (disk?.data) {
								data = disk.data;
								fetchedAt = disk.fetchedAt;
							}
						} catch {
							// Disk cache is best-effort; missing data is reported below.
						}
					}
					return { cfg, data, fetchedAt, lastError: state?.lastError };
				}),
			);

			// Order: active provider first, then providers with data (freshest first), then empty providers
			const ordered = [...resolved].sort((a, b) => {
				const aActive = a.cfg === activeCfg ? 1 : 0;
				const bActive = b.cfg === activeCfg ? 1 : 0;
				if (aActive !== bActive) return bActive - aActive;
				const aHas = a.data ? 1 : 0;
				const bHas = b.data ? 1 : 0;
				if (aHas !== bHas) return bHas - aHas;
				return (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0);
			});

			const sections: string[] = [];
			const emptyIds: string[] = [];
			const now = Date.now();
			for (const { cfg, data, fetchedAt, lastError } of ordered) {
				const isActive = cfg === activeCfg;
				const modelId = isActive ? model?.id : undefined;
				if (data) {
					sections.push(
						formatUsageDetails(cfg.id === "codex-pool" && selectedPoolAccount ? {
							...data,
							accounts: data.accounts?.map((account) => ({ ...account, active: account.id === selectedPoolAccount })),
						} : data, cfg.id, {
							modelId,
							fetchedAt,
							now,
							theme: uiTheme,
							active: isActive,
						}),
					);
				} else if (lastError || !hasColor) {
					const emptyMsg = lastError ?? "no usage data yet";
					sections.push(
						hasColor
							? `${ctp("red", `⚠ ${cfg.id}`)}${ctp("subtext0", `: ${emptyMsg}`)}`
							: `${cfg.id}: ${emptyMsg}`,
					);
				} else {
					emptyIds.push(cfg.id);
				}
			}
			if (emptyIds.length > 0) {
				const dot = ctp("surface2", " · ");
				sections.push(
					`${ctp("overlay1", "○ No data:")} ${emptyIds.map((id) => ctp("surface2", id)).join(dot)}`,
				);
			}
			const hiddenHint = mode === "off" ? "\n(Usage hidden — /usage toggle to restore it)" : "";
			ctx.ui.notify(sections.join("\n\n") + hiddenHint, "info");
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		route(ctx, true);
	});

	pi.on("model_select", async (_event, ctx) => {
		route(ctx, true);
	});

	// Agent finished answering (incl. auto-retry/compaction settle) — usage
	// may have moved; the cooldown in refresh() decides if a real fetch is due.
	pi.on("agent_settled", async (_event, ctx) => {
		route(ctx, false);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopDiskCacheWatcher();
		if (cacheSyncTimer) {
			clearTimeout(cacheSyncTimer);
			cacheSyncTimer = undefined;
		}
		for (const c of cfgs) clear(ctx, c.id);
		currentCtx = undefined;
	});
}
