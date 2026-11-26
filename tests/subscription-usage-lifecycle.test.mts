import assert from "node:assert/strict";
import fs from "node:fs";
import { stripVTControlCharacters } from "node:util";
import test, { type TestContext } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import registerFastMode from "../extensions/fast-mode/index.ts";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import subscriptionUsage, {
	antigravityCfg,
	alpakyrosPoolCfg,
	claudeCliCfg,
	codexCfg,
	codexPoolCfg,
	deepseekCfg,
	hmsCfg,
	xingchiapiCfg,
	MissingCredentialError,
	opencodeCfg,
	usageProviderCfgs,
} from "../extensions/subscription-usage.ts";

async function flush() {
	// Drain the scheduler's async cache/read/write continuations without real timers.
	for (let i = 0; i < 60; i++) await Promise.resolve();
}

function harness(t: TestContext, mode = "bars", codexLbProviders: string[] = [], bus?: ExtensionAPI["events"]) {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	t.mock.method(Math, "random", () => 0.5);
	t.mock.method(console, "error", () => {});
	t.mock.method(fs, "readFileSync", () => JSON.stringify({ mode, codexLbProviders }));
	t.mock.method(fs.promises, "readFile", async () => "{}");
	t.mock.method(fs.promises, "mkdir", async () => undefined);
	t.mock.method(fs.promises, "writeFile", async () => {});
	t.mock.method(fs.promises, "rename", async () => {});
	t.mock.method(fs.promises, "unlink", async () => {});
	let watchListener: (curr: fs.Stats, prev: fs.Stats) => void;
	const watch = t.mock.method(fs, "watchFile", (...args: unknown[]) => {
		watchListener = args.at(-1) as typeof watchListener;
		return {};
	});
	const unwatch = t.mock.method(fs, "unwatchFile", () => {});
	// Every provider is mocked: `/usage refresh` fans out by default, so an
	// unmocked provider would attempt a real network request.
	const fetch = t.mock.method(codexCfg, "fetchUsage", async () => ({ windows: { "5h": 12 } }));
	const providerFetches = {
		"opencode-go": t.mock.method(opencodeCfg, "fetchUsage", async () => ({ windows: { rolling: 5 } })),
		"openai-codex": fetch,
		"alpakyros-pool": t.mock.method(alpakyrosPoolCfg, "fetchUsage", async () => ({ windows: {}, plan: "Key 1 inactive · unlimited" })),
		"codex-pool": t.mock.method(codexPoolCfg, "fetchUsage", async () => ({ windows: { "account 5h": 20 } })),
		antigravity: t.mock.method(antigravityCfg, "fetchUsage", async () => ({ windows: { "gemini-5h": 8 } })),
		"claude-cli": t.mock.method(claudeCliCfg, "fetchUsage", async () => ({ windows: { "5h": 10 } })),
		deepseek: t.mock.method(deepseekCfg, "fetchUsage", async () => ({ windows: { "deepseek-5h": 3 } })),
		hms: t.mock.method(hmsCfg, "fetchUsage", async () => ({ windows: { daily: 25 } })),
		xingchiapi: t.mock.method(xingchiapiCfg, "fetchUsage", async () => ({ windows: {}, balance: { currency: "USD", total: 42 } })),
	};
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const statuses = new Map<string, string | undefined>();
	const ctx = {
		model: { provider: "openai-codex", id: "gpt-5" },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			notify: () => {},
		},
	} as unknown as ExtensionCommandContext;
	subscriptionUsage({
		events: bus,
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => events.set(name, handler),
		registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, command),
	} as unknown as ExtensionAPI);
	async function event(name: string) {
		await events.get(name)!({}, ctx);
		await flush();
	}
	t.after(async () => { await event("session_shutdown"); });
	return { watch, unwatch, fetch, providerFetches, statuses, ctx, event, commands,
		get watchListener() { return watchListener; },
	};
}

test("configured codex-lb provider uses its own URL/auth and default refresh stays active-only", async (t) => {
	const h = harness(t, "bars", ["macmini-codex"]);
	const model = { provider: "macmini-codex", id: "gpt-6-astra", baseUrl: "http://macmini:2455/v1" };
	h.ctx.model = model as typeof h.ctx.model;
	const auth = t.mock.fn(async () => ({ ok: true, apiKey: "lb-test-key", headers: { "X-Proxy": "test" } }));
	h.ctx.modelRegistry = { getAll: () => [model], getApiKeyAndHeaders: auth } as unknown as typeof h.ctx.modelRegistry;
	const http = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
		limits: [
			{ limit_type: "credits", limit_window: "5h", max_value: 900, current_value: 83, reset_at: "2027-01-01T00:00:00Z" },
			{ limit_type: "credits", limit_window: "7d", max_value: 30240, current_value: 2873 },
		], account_pool_usage: { primary: 90.75, secondary: 90.5 },
	})));
	const notify = t.mock.method(h.ctx.ui, "notify");
	await h.event("session_start");
	await h.commands.get("usage")!.handler("refresh", h.ctx);
	assert.equal(String(http.mock.calls.at(-1)!.arguments[0]), "http://macmini:2455/v1/usage");
	const options = http.mock.calls.at(-1)!.arguments[1];
	assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer lb-test-key");
	assert.equal(new Headers(options?.headers).get("X-Proxy"), "test");
	assert.equal(options?.redirect, "error");
	assert.match(h.statuses.get("macmini-codex")!, /Pool 5h used:.*9\.3%.*Pool W used:.*9\.5%.*Limit 5h used:.*9\.2%/);
	assert.match(notify.mock.calls.at(-1)!.arguments[0], /Usage refreshed for macmini-codex/);
	assert.match(h.statuses.get("macmini-codex")!, /^○ 󰘨 usage: /);
	assert.equal(h.fetch.mock.callCount(), 0);
	assert.equal(h.providerFetches.antigravity.mock.callCount(), 0);
	assert.equal(h.watch.mock.callCount(), 0);
	await h.commands.get("usage")!.handler("toggle percent", h.ctx);
	const write = t.mock.method(fs.promises, "writeFile", async (_path: unknown, data: unknown) => {
		assert.deepEqual(JSON.parse(String(data)), { mode: "off", codexLbProviders: ["macmini-codex"] });
	});
	await h.commands.get("usage")!.handler("toggle off", h.ctx);
	assert.equal(write.mock.callCount(), 1);
	write.mock.restore();
	await h.commands.get("usage")!.handler("toggle bars", h.ctx);
	h.ctx.model = { provider: "openai-codex", id: "gpt-5" } as typeof h.ctx.model;
	await h.event("model_select");
	assert.equal(h.statuses.get("macmini-codex"), undefined);
	assert.equal(h.fetch.mock.callCount(), 1);
});

test("xingchi usage ribbon stays readable on resize, preserves stale warnings and follows theme changes", async (t) => {
 const h = harness(t);
 h.ctx.model = { provider: "xingchiapi", id: "test" } as typeof h.ctx.model;
 h.providerFetches.xingchiapi.mock.mockImplementation(async () => ({ windows: {}, balance: { currency: "USD", total: 882.28 }, plan: "xingchiapi · unrestricted · 801 requests today" }));
 const widgets = new Map<string, Component>();
 Object.assign(h.ctx.ui, { setWidget(key: string, factory: Parameters<ExtensionContext["ui"]["setWidget"]>[1]) {
  if (!factory) widgets.delete(key);
  else if (typeof factory === "function") widgets.set(key, factory({} as never, h.ctx.ui.theme));
 } });
 await h.event("session_start");
 const widget = widgets.get("subscription-usage:xingchiapi")!;
 assert.ok(widget);
 assert.equal(h.statuses.get("xingchiapi"), undefined);
 assert.deepEqual(widget.render(80), ["xingchi  $882.28 balance   801 req today   unrestricted"]);
 for (let width = 1; width <= 120; width++) {
  const lines = widget.render(width);
  assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
  const text = lines.map(stripVTControlCharacters).join("").replaceAll(" ", "");
  for (const value of ["xingchi", "$882.28", "balance", "801reqtoday", "unrestricted"]) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /usage:|○/);
 }
 h.ctx.ui.theme.fg = (_color: string, text: string) => `\x1b[33m${text}\x1b[39m`;
 widget.invalidate();
 assert.ok(widget.render(80).join("").includes("\x1b[1m$882.28\x1b[22m"));
 h.providerFetches.xingchiapi.mock.mockImplementation(async () => { throw new Error("temporary outage"); });
 await h.commands.get("usage")!.handler("refresh", h.ctx);
 const stale = widgets.get("subscription-usage:xingchiapi")!;
 const warning = stripVTControlCharacters(stale.render(80).join(""));
 assert.match(warning, /\$882\.28.*801 req today.*⚠/);
 assert.doesNotMatch(warning, /usage:|○/);
 h.ctx.ui.theme.fg = (_color: string, text: string) => text;
 stale.invalidate();
 assert.ok(!stale.render(80).join("").includes("\x1b"));
});

test("xingchi usage fallback uses its own provider label without inventing missing usage", async (t) => {
 const h = harness(t);
 h.ctx.model = { provider: "xingchiapi", id: "test" } as typeof h.ctx.model;
 await h.event("session_start");
 assert.equal(h.statuses.get("xingchiapi"), "xingchi  $42.00 balance");
});

test("usage widget reflows on resize without losing quota or sharing the throughput line", async (t) => {
	const h = harness(t);
	let widget: Component | undefined;
	const currentWidget = (): Component | undefined => widget;
	h.ctx.ui.theme.fg = (_color: string, text: string) => `\x1b[33m${text}\x1b[0m`;
	Object.assign(h.ctx.ui, {
		setWidget(_key: string, factory: Parameters<ExtensionContext["ui"]["setWidget"]>[1], options: unknown) {
			assert.deepEqual(options, { placement: "belowEditor" });
			widget = typeof factory === "function"
				? factory({} as never, h.ctx.ui.theme) : undefined;
		},
	});
	h.fetch.mock.mockImplementation(async () => ({
		windows: { "Pool 5h used": 0, "Pool W used": 11, "Limit 5h used": 2, "Limit W used": 34 },
		resets: { "Limit 5h used": Date.now() + 4 * 3600_000 },
		plan: "codex-lb",
	}));
	await h.event("session_start");
	assert.ok(widget, "usage should use a width-aware widget, not a truncated footer status");
	assert.equal(h.statuses.get("openai-codex"), undefined);
	assert.match(stripVTControlCharacters(widget.render(200).join("\n")), /^○ 󰘨 usage: /);
	assert.match(widget.render(200).join("\n"), /░/);
	for (const width of [100, 80, 60, 40, 20, 10, 1]) {
		const lines = widget.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
		if (width >= 20) {
			const text = lines.join(" ");
			for (const percent of ["0%", "11%", "2%", "34%"]) assert.ok(text.includes(percent), text);
			assert.match(text, /Pool/);
			assert.match(text, /Limit/);
			assert.match(text, /~4h/);
			assert.doesNotMatch(text, /░|█|\.\.\./);
		}
	}
	assert.match(widget.render(200).join("\n"), /░/, "bars return when widened");
	await h.commands.get("usage")!.handler("toggle off", h.ctx);
	assert.equal(widget, undefined);
	await h.commands.get("usage")!.handler("toggle bars", h.ctx);
	await flush();
	assert.ok(currentWidget());
	h.fetch.mock.mockImplementation(async () => { throw new Error("temporary outage"); });
	await h.commands.get("usage")!.handler("refresh", h.ctx);
	const restored = currentWidget();
	assert.ok(restored);
	assert.match(restored.render(60).join(" "), /⚠/);
	h.ctx.ui.theme.fg = (_color: string, text: string) => text;
	restored.invalidate();
	assert.doesNotMatch(restored.render(60).join(" "), /\x1b/, "theme is recomputed, not cached");
	h.ctx.model = { provider: "unconfigured", id: "other" } as typeof h.ctx.model;
	await h.event("model_select");
	assert.equal(widget, undefined);
	await h.event("session_shutdown");
	assert.equal(widget, undefined);
});

test("unknown active provider is not probed and default refresh does not query saved accounts", async (t) => {
	const h = harness(t);
	h.ctx.model = { provider: "custom-not-opted-in", id: "gpt" } as typeof h.ctx.model;
	const notify = t.mock.method(h.ctx.ui, "notify");
	const http = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
	await h.event("session_start");
	await h.commands.get("usage")!.handler("refresh", h.ctx);
	assert.match(notify.mock.calls.at(-1)!.arguments[0], /not configured.*custom-not-opted-in/);
	assert.equal(http.mock.callCount(), 0);
	for (const fetch of Object.values(h.providerFetches)) assert.equal(fetch.mock.callCount(), 0);
});

test("refresh notices expose failure details and clear them after recovery", async (t) => {
	const h = harness(t);
	const notify = t.mock.method(h.ctx.ui, "notify");
	h.fetch.mock.mockImplementation(async () => { throw new Error("HTTP 401: token_revoked; use /login for openai-codex"); });
	await h.event("session_start");
	for (const target of ["active", "all"]) {
		await h.commands.get("usage")!.handler(`refresh ${target}`, h.ctx);
		assert.match(notify.mock.calls.at(-1)!.arguments[0], /token_revoked; use \/login for openai-codex/);
	}
	h.fetch.mock.mockImplementation(async () => ({ windows: { "5h": 12 } }));
	await h.commands.get("usage")!.handler("refresh active", h.ctx);
	assert.equal(notify.mock.calls.at(-1)!.arguments[0], "Usage refreshed for openai-codex");
});

test("usage watcher starts only with a session and shutdown removes only its listener", async (t) => {
	const h = harness(t);
	assert.equal(h.watch.mock.callCount(), 0);
	await h.event("session_start");
	assert.equal(h.watch.mock.callCount(), 1);
	await h.event("session_shutdown");
	const args = h.unwatch.mock.calls[0].arguments;
	assert.equal(args[1], h.watchListener);
});

test("scheduled retries recover after failure while event pokes respect backoff", async (t) => {
	const h = harness(t);
	let attempts = 0;
	h.fetch.mock.mockImplementation(async () => {
		if (++attempts <= 2) throw new Error("temporary outage");
		return { windows: { "5h": 12 } };
	});
	await h.event("session_start");
	assert.equal(attempts, 1);
	await h.event("agent_settled");
	assert.equal(attempts, 1);
	t.mock.timers.tick(20_000);
	await flush();
	assert.equal(attempts, 2);
	t.mock.timers.tick(40_000);
	await flush();
	assert.equal(attempts, 3);
	assert.match(h.statuses.get("openai-codex")!, /12%/);
});

test("manual refresh while hidden does not fetch, render, or start polling", async (t) => {
	const h = harness(t, "off");
	await h.event("session_start");
	await h.commands.get("usage")!.handler("refresh", h.ctx);
	await flush();
	assert.equal(h.fetch.mock.callCount(), 0);
	assert.equal(h.statuses.size, 0);
	t.mock.timers.tick(600_000);
	await flush();
	assert.equal(h.fetch.mock.callCount(), 0);
});

test("hiding usage discards an outstanding provider result", async (t) => {
	const h = harness(t);
	let finish!: (data: { windows: Record<string, number> }) => void;
	h.fetch.mock.mockImplementation(() => new Promise<{ windows: Record<string, number> }>((resolve) => { finish = resolve; }));
	await h.event("session_start");
	await h.commands.get("usage")!.handler("toggle off", h.ctx);
	finish({ windows: { "5h": 12 } });
	await flush();
	assert.equal(h.statuses.get("openai-codex"), undefined);
	t.mock.timers.tick(600_000);
	await flush();
	assert.equal(h.fetch.mock.callCount(), 1);
});

test("disk sync cannot restore polling after shutdown during a cache read", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	let finish!: (data: string) => void;
	t.mock.method(fs.promises, "readFile", () => new Promise<string>((resolve) => { finish = resolve; }));
	h.watchListener({ mtimeMs: 2 } as fs.Stats, { mtimeMs: 1 } as fs.Stats);
	t.mock.timers.tick(100);
	await flush();
	await h.event("session_shutdown");
	finish(JSON.stringify({ "openai-codex": {
		data: { windows: { "5h": 99 } }, fetchedAt: Date.now() + 1,
	} }));
	await flush();
	assert.equal(h.statuses.get("openai-codex"), undefined);
	t.mock.timers.tick(600_000);
	await flush();
	assert.equal(h.fetch.mock.callCount(), 1);
});

test("/usage shows all providers", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	assert.ok(h.commands.has("usage"));
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	h.fetch.mock.mockImplementation(async () => ({
		windows: { "5h": 12, weekly: 34 },
		resets: { "5h": Date.now() + 3600_000, weekly: Date.now() + 86400_000 },
		plan: "plus",
	}));
	await h.commands.get("usage")!.handler("", h.ctx);
	await flush();
	const last = notices.at(-1)!;
	assert.match(last, /Subscription usage — openai-codex/);
	assert.match(last, /• 5h\s+12%/);
	assert.match(last, /• weekly\s+34%/);
	// Default view covers every provider; unconfigured ones report no data.
	assert.match(last, /opencode-go/);
	assert.match(last, /antigravity/);
});

test("/usage works while hidden without fetching", async (t) => {
	const h = harness(t, "off");
	await h.event("session_start");
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("", h.ctx);
	await flush();
	assert.equal(h.fetch.mock.callCount(), 0);
	assert.match(notices.at(-1)!, /opencode-go/);
	assert.match(notices.at(-1)!, /Usage hidden/);
});

test("/usage toggle cycles footer style", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("toggle", h.ctx);
	await flush();
	assert.match(notices.at(-1)!, /Subscription usage style: percent/);
	await h.commands.get("usage")!.handler("toggle bars", h.ctx);
	await flush();
	assert.match(notices.at(-1)!, /Subscription usage style: bars/);
});

test("/usage refresh all force-fetches every provider explicitly", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	assert.equal(h.fetch.mock.callCount(), 1);
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("refresh all", h.ctx);
	await flush();
	// Session start fetched the active provider only; explicit all fans out.
	assert.equal(h.fetch.mock.callCount(), 2);
	for (const [id, mocked] of Object.entries(h.providerFetches)) {
		if (id === "openai-codex") continue;
		assert.equal(mocked.mock.callCount(), 1, id);
	}
	assert.match(notices.at(-1)!, new RegExp(`Usage refreshed for all ${usageProviderCfgs.length} providers`));
});

test("/usage refresh <provider> refreshes only that provider", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("refresh deepseek", h.ctx);
	await flush();
	assert.equal(h.providerFetches.deepseek.mock.callCount(), 1);
	assert.equal(h.providerFetches["opencode-go"].mock.callCount(), 0);
	assert.equal(h.fetch.mock.callCount(), 1); // session start only
	assert.equal(notices.at(-1), "Usage refreshed for deepseek");
});

test("/usage refresh active and provider aliases target one provider", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("refresh active", h.ctx);
	await flush();
	assert.equal(notices.at(-1), "Usage refreshed for openai-codex");
	// `codex` is an unambiguous alias for the openai-codex provider.
	await h.commands.get("usage")!.handler("refresh codex", h.ctx);
	await flush();
	assert.equal(notices.at(-1), "Usage refreshed for openai-codex");
	assert.equal(h.providerFetches.deepseek.mock.callCount(), 0);
	assert.equal(h.providerFetches["opencode-go"].mock.callCount(), 0);
});

test("/usage refresh with an unknown target warns without any request", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	const notices: { msg: string; level?: string }[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string, level?: string) => void }).notify = (msg, level) =>
		notices.push({ msg, level });
	const before = [h.fetch.mock.callCount(), h.providerFetches.deepseek.mock.callCount()];
	await h.commands.get("usage")!.handler("refresh bogus", h.ctx);
	await flush();
	assert.equal(notices.at(-1)!.level, "warning");
	assert.match(notices.at(-1)!.msg, /Unknown usage provider/);
	assert.deepEqual([h.fetch.mock.callCount(), h.providerFetches.deepseek.mock.callCount()], before);
});

test("fan-out refresh writes a footer status for the active provider only", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	await h.commands.get("usage")!.handler("refresh all", h.ctx);
	await flush();
	// Providers we are not using must not leak status widgets into the footer.
	for (const cfg of usageProviderCfgs) {
		if (cfg.id === "openai-codex") continue;
		assert.equal(h.statuses.get(cfg.id), undefined, cfg.id);
	}
	assert.match(h.statuses.get("openai-codex")!, /12%/);
});

test("a provider without credentials is reported as skipped, not failed", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	h.providerFetches.deepseek.mock.mockImplementation(async () => {
		throw new MissingCredentialError("no API key (DEEPSEEK_API_KEY or auth.json)");
	});
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("refresh all", h.ctx);
	await flush();
	assert.match(notices.at(-1)!, /no credentials: deepseek/);
	assert.doesNotMatch(notices.at(-1)!, /failed:/);
});

test("a provider whose fetch rejects is reported as failed", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	h.providerFetches.deepseek.mock.mockImplementation(async () => {
		throw new Error("HTTP 503");
	});
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("refresh all", h.ctx);
	await flush();
	assert.match(notices.at(-1)!, /failed: deepseek/);
});

test("/usage help and unknown subcommands notify", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("help", h.ctx);
	await h.commands.get("usage")!.handler("bogus", h.ctx);
	await flush();
	assert.match(notices[0], /\/usage toggle/);
	assert.match(notices[1], /Unknown subcommand/);
});

test("event pokes arriving during retry backoff do not postpone the retry deadline", async (t) => {
	const h = harness(t);
	let attempts = 0;
	h.fetch.mock.mockImplementation(async () => {
		if (++attempts === 1) throw new Error("outage");
		return { windows: { "5h": 50 } };
	});

	await h.event("session_start");
	assert.equal(attempts, 1);

	// Poke halfway through the 20s backoff (at 10s)
	t.mock.timers.tick(10_000);
	await h.event("agent_settled");
	assert.equal(attempts, 1);

	// Advance the remaining 10s to reach the original 20s deadline
	t.mock.timers.tick(10_000);
	await flush();
	// The retry must fire at the original 20s deadline, NOT postponed to 30s!
	assert.equal(attempts, 2);
	assert.match(h.statuses.get("openai-codex")!, /50%/);
});

test("toggling usage off aborts active fetch via signal", async (t) => {
	const h = harness(t);
	let receivedSignal: AbortSignal | undefined;
	h.fetch.mock.mockImplementation(async (signal?: AbortSignal) => {
		receivedSignal = signal;
		return new Promise<{ windows: Record<string, number> }>((_, reject) => {
			signal?.addEventListener("abort", () => reject(new Error("aborted")));
		});
	});

	await h.event("session_start");
	assert.ok(receivedSignal);
	assert.equal(receivedSignal.aborted, false);

	await h.commands.get("usage")!.handler("toggle off", h.ctx);
	await flush();
	assert.equal(receivedSignal.aborted, true);
});

test("manual model check renders inference result across model switches", async (t) => {
	const h = harness(t);
	h.ctx.model = { provider: "hms", id: "test" } as typeof h.ctx.model;
	let succeed = true;
	const stream = t.mock.fn((_model: unknown, context: unknown, options: { maxTokens: number }) => {
		assert.equal(options.maxTokens, 64);
		assert.deepEqual((context as { messages: { content: string }[] }).messages.map((m) => m.content), ["Reply OK."]);
		return { result: async () => ({ stopReason: succeed ? "stop" : "error", content: [{ type: "text", text: "OK" }] }) };
	});
	h.ctx.modelRegistry = { streamSimple: stream } as unknown as typeof h.ctx.modelRegistry;
	const notify = t.mock.method(h.ctx.ui, "notify");
	await h.event("session_start");
	assert.equal(stream.mock.callCount(), 0);
	await h.commands.get("usage")!.handler("check", h.ctx);
	assert.match(h.statuses.get("usage-model-health")!, /hms\/test ✓/);
	await h.commands.get("usage")!.handler("", h.ctx);
	assert.match(notify.mock.calls.at(-1)!.arguments[0], /hms\/test: OK/);
	succeed = false;
	await h.commands.get("usage")!.handler("check", h.ctx);
	assert.match(h.statuses.get("usage-model-health")!, /test !/);
	await h.event("model_select");
	assert.match(h.statuses.get("usage-model-health")!, /test !/);
});

test("automatic checks poll both providers without a command and survive model switches", async (t) => {
	const h = harness(t);
	const models = [{ provider: "hms", id: "one" }, { provider: "xingchiapi", id: "two" }];
	const stream = t.mock.fn(() => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "OK" }] }) }));
	h.ctx.modelRegistry = { getAll: () => [...models, models[0], { provider: "other", id: "skip" }], streamSimple: stream } as unknown as typeof h.ctx.modelRegistry;
	const notify = t.mock.method(h.ctx.ui, "notify");
	await h.event("session_start");
	assert.equal(stream.mock.callCount(), 2);
	assert.match(h.statuses.get("usage-model-health")!, /hms\/one ✓.*xingchi\/two ✓/);
	assert.equal(notify.mock.callCount(), 0);
	await h.event("model_select");
	assert.equal(stream.mock.callCount(), 2);
	t.mock.timers.tick(60_000);
	await flush();
	assert.equal(stream.mock.callCount(), 4);
	await h.commands.get("usage")!.handler("", h.ctx);
	assert.match(notify.mock.calls.at(-1)!.arguments[0], /xingchiapi\/two: OK/);
	await h.commands.get("usage")!.handler("toggle off", h.ctx);
	t.mock.timers.tick(120_000);
	await flush();
	assert.equal(stream.mock.callCount(), 4);
	assert.equal(h.statuses.get("usage-model-health"), undefined);
	await h.commands.get("usage")!.handler("toggle percent", h.ctx);
	await flush();
	assert.equal(stream.mock.callCount(), 6);
});

test("health widget stays compact, reflows and clears on hide", async (t) => {
	const h = harness(t);
	let widget: Component | undefined;
	Object.assign(h.ctx.ui, { setWidget(key: string, factory: Parameters<ExtensionContext["ui"]["setWidget"]>[1]) {
		if (key === "usage-model-health") widget = typeof factory === "function" ? factory({} as never, h.ctx.ui.theme) : undefined;
	} });
	h.ctx.modelRegistry = {
		getAll: () => [{ provider: "hms", id: "deepseek-v4.1-flash-free" }, { provider: "xingchiapi", id: "gpt-6.1-sol" }],
		streamSimple: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "OK" }] }) }),
	} as unknown as typeof h.ctx.modelRegistry;
	await h.event("session_start");
	assert.ok(widget);
	assert.equal(widget.render(120).length, 1);
	assert.doesNotMatch(widget.render(120).join(""), /may use credits|models|ago|Model checks/);
	for (const width of [40, 10, 1]) assert.ok(widget.render(width).every((line) => visibleWidth(line) <= width));
	h.ctx.ui.theme.fg = (_color: string, text: string) => `\x1b[32m${text}\x1b[0m`;
	widget.invalidate();
	assert.ok(widget.render(120).join("").includes("\x1b"));
	await h.commands.get("usage")!.handler("toggle off", h.ctx);
	assert.equal(widget, undefined);
});

test("automatic checks time out, do not overlap, and stop on shutdown", async (t) => {
	const h = harness(t);
	const signals: AbortSignal[] = [];
	const stream = t.mock.fn((_m: unknown, _c: unknown, options: { signal: AbortSignal }) => {
		signals.push(options.signal);
		return { result: () => new Promise(() => {}) };
	});
	h.ctx.modelRegistry = { getAll: () => [{ provider: "hms", id: "one" }], streamSimple: stream } as unknown as typeof h.ctx.modelRegistry;
	await h.event("session_start");
	await h.commands.get("usage")!.handler("check", h.ctx);
	assert.equal(stream.mock.callCount(), 1);
	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(signals[0].aborted, true);
	assert.match(h.statuses.get("usage-model-health")!, /one !/);
	t.mock.timers.tick(60_000);
	await flush();
	assert.equal(stream.mock.callCount(), 2);
	await h.event("session_shutdown");
	assert.equal(signals[1].aborted, true);
	t.mock.timers.tick(120_000);
	await flush();
	assert.equal(stream.mock.callCount(), 2);
	assert.equal(h.statuses.get("usage-model-health"), undefined);
});

test("off cancels queued models and an old sweep cannot overwrite a restored sweep", async (t) => {
	const h = harness(t);
	const finish: (() => void)[] = [];
	const signals: AbortSignal[] = [];
	const stream = t.mock.fn((_m: unknown, _c: unknown, options: { signal: AbortSignal }) => {
		signals.push(options.signal);
		return { result: () => new Promise((resolve) => { finish.push(() => resolve({ stopReason: "stop", content: [{ type: "text", text: "OK" }] })); }) };
	});
	h.ctx.modelRegistry = { getAll: () => ["one", "two", "three"].map((id) => ({ provider: "hms", id })), streamSimple: stream } as unknown as typeof h.ctx.modelRegistry;
	await h.event("session_start");
	assert.equal(stream.mock.callCount(), 2);
	await h.commands.get("usage")!.handler("toggle off", h.ctx);
	await flush();
	assert.ok(signals.slice(0, 2).every((signal) => signal.aborted));
	assert.equal(stream.mock.callCount(), 2);
	await h.commands.get("usage")!.handler("toggle bars", h.ctx);
	await flush();
	assert.equal(stream.mock.callCount(), 4);
	finish[0](); finish[1]();
	await flush();
	assert.equal(stream.mock.callCount(), 4);
	assert.doesNotMatch(h.statuses.get("usage-model-health")!, /✓/);
	await h.event("session_shutdown");
	assert.ok(signals.every((signal) => signal.aborted));
	assert.equal(stream.mock.callCount(), 4);
});

test("model checks reject unsupported providers and discard cancelled results", async (t) => {
	const h = harness(t);
	await h.commands.get("usage")!.handler("check", h.ctx);
	assert.equal(h.statuses.get("usage-model-health"), undefined);
	h.ctx.model = { provider: "xingchiapi", id: "test" } as typeof h.ctx.model;
	let finish!: () => void;
	let signal!: AbortSignal;
	h.ctx.modelRegistry = { streamSimple: (_m: unknown, _c: unknown, options: { signal: AbortSignal }) => {
		signal = options.signal;
		return { result: () => new Promise((resolve) => { finish = () => resolve({ stopReason: "stop", content: [{ type: "text", text: "OK" }] }); }) };
	} } as unknown as typeof h.ctx.modelRegistry;
	const pending = h.commands.get("usage")!.handler("check", h.ctx);
	await h.event("session_shutdown");
	assert.equal(signal.aborted, true);
	finish();
	await pending;
	assert.equal(h.statuses.get("usage-model-health"), undefined);
});

test("concurrent model selections coalesce in-flight fetch without duplicate HTTP requests", async (t) => {
	const h = harness(t);
	let finish!: (d: { windows: Record<string, number> }) => void;
	h.fetch.mock.mockImplementation(async () => new Promise<{ windows: Record<string, number> }>((resolve) => { finish = resolve; }));

	await h.event("session_start");
	assert.equal(h.fetch.mock.callCount(), 1);

	// Rapid model selections while request is in flight
	await h.event("model_select");
	await h.event("model_select");
	assert.equal(h.fetch.mock.callCount(), 1);

	finish({ windows: { "5h": 25 } });
	await flush();
	assert.match(h.statuses.get("openai-codex")!, /25%/);
});

for (const order of ['producer-first', 'dock-first']) test(`telemetry dock ownership and lifecycle (${order})`, async (t) => {
  const bus = createEventBus();
  const h = harness(t, 'bars', [], bus);
  h.ctx.model = { provider: 'xingchiapi', id: 'gpt-6.1-sol', api: 'openai-responses' } as typeof h.ctx.model;
  h.ctx.modelRegistry = { getAll: () => [] } as unknown as typeof h.ctx.modelRegistry;
  const widgets = new Map<string, readonly string[]>();
  Object.assign(h.ctx.ui, { setWidget(key: string, factory: Parameters<ExtensionContext['ui']['setWidget']>[1]) {
    if (!factory) { widgets.delete(key); return; }
    if (typeof factory !== 'function') return;
    widgets.set(key, factory({ requestRender() {} } as never, h.ctx.ui.theme as never).render(80));
  } });
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  registerFastMode({ events: bus, on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => events.set(name, handler),
    registerShortcut() {}, registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, command),
  } as unknown as ExtensionAPI);
  const ctx = { ...h.ctx, mode: 'tui', hasUI: true } as ExtensionCommandContext;
  if (order === 'dock-first') await h.event('session_start');
  await events.get('session_start')!({}, ctx);
  if (order === 'producer-first') {
    assert.equal(h.statuses.get('pi-pulse-fast'), '○ 󱐋 fast');
    await h.event('session_start');
  }
  await h.event('session_start');
  assert.equal(h.statuses.get('pi-pulse-fast'), undefined);
  assert.match(widgets.get('usage-model-health')!.join(''), /fast ○/);
  bus.emit('pi-pulse:telemetry:v1', { kind: 'compact', scope: ':xingchiapi/gpt-6.1-sol', data: { tokens: 146_076, limit: 300_000, contextWindow: 1_000_000 } });
  assert.match(widgets.get('usage-model-health')!.join(''), /compact.*in 153\.9k.*[(]30%[)]/);
  await commands.get('fast')!.handler('on', ctx);
  assert.match(widgets.get('usage-model-health')!.join(''), /fast ●/);
  assert.equal(h.statuses.get('pi-pulse-fast'), undefined);
  await h.commands.get('usage')!.handler('toggle off', h.ctx);
  assert.equal(widgets.has('usage-model-health'), false);
  assert.equal(h.statuses.get('pi-pulse-fast'), '● 󱐋 fast');
  await h.commands.get('usage')!.handler('toggle bars', h.ctx);
  assert.match(widgets.get('usage-model-health')!.join(''), /fast ●/);
  h.ctx.model = { ...h.ctx.model!, provider: 'other' } as typeof h.ctx.model;
  await h.event('model_select');
  assert.equal(widgets.has('usage-model-health'), false);
  await events.get('model_select')!({}, { ...ctx, model: h.ctx.model });
  assert.ok(widgets.get('usage-model-health')!.join('').includes('fast —'));
  assert.doesNotMatch(widgets.get('usage-model-health')!.join(''), /compact/);
  await h.event('session_shutdown');
  assert.equal(widgets.has('usage-model-health'), false);
  assert.equal(h.statuses.get('pi-pulse-fast'), '— 󱐋 fast');
  await events.get('session_shutdown')!({}, ctx);
  bus.emit('pi-pulse:telemetry-request:v1', {});
  assert.equal(widgets.has('usage-model-health'), false);
  assert.equal(h.statuses.get('pi-pulse-fast'), undefined);
});

test('telemetry does not claim fallback if widget registration fails', async (t) => {
  const bus = createEventBus();
  const h = harness(t, 'bars', [], bus);
  h.ctx.model = { provider: 'other', id: 'test' } as typeof h.ctx.model;
  const announcements: unknown[] = [];
  bus.on('pi-pulse:telemetry-dock:v1', (value) => announcements.push(value));
  Object.assign(h.ctx.ui, { setWidget() { throw new Error('UI unavailable'); } });
  await h.event('session_start');
  bus.emit('pi-pulse:telemetry:v1', { kind: 'fast', scope: ':other/test', data: 'off' });
  assert.ok(!announcements.some((value) => (value as { available: boolean }).available));
  Object.assign(h.ctx.ui, { setWidget() {} });
});

test('health and telemetry share one dock through updates, clearing, model changes and shutdown', async (t) => {
  const bus = createEventBus();
  const h = harness(t, 'bars', [], bus);
  const widgets = new Map<string, Component>();
  Object.assign(h.ctx.ui, { setWidget(key: string, factory: Parameters<ExtensionContext['ui']['setWidget']>[1]) {
    if (!factory) widgets.delete(key);
    else if (typeof factory === 'function') widgets.set(key, factory({} as never, h.ctx.ui.theme));
  } });
  const flash = { provider: 'hms', id: 'deepseek-v4.1-flash-free' };
  const sol = { provider: 'xingchiapi', id: 'gpt-6.1-sol' };
  let models = [flash, sol];
  const pending = new Map<string, (value: unknown) => void>();
  h.ctx.model = sol as typeof h.ctx.model;
  h.ctx.modelRegistry = {
    getAll: () => models,
    streamSimple: (model: { id: string }) => ({ result: () => new Promise((resolve) => pending.set(model.id, resolve)) }),
  } as unknown as typeof h.ctx.modelRegistry;
  const render = () => widgets.get('usage-model-health')!.render(100).join('\n');
  const publish = (kind: string, data: unknown, scope = ':xingchiapi/gpt-6.1-sol') => bus.emit('pi-pulse:telemetry:v1', { kind, data, scope });
  await h.event('session_start');
  publish('compact', { tokens: 146_076, limit: 300_000, contextWindow: 1_000_000 });
  publish('fast', 'off');
  assert.match(render(), /hms\/.*xingchi\/.*compact.*fast/s);
  assert.match(render(), /[(]30%[)]/);
  assert.match(render(), /Flash ○.*Sol ○.*in 153[.]9k.*fast ○/s);
  assert.equal(widgets.has('usage-telemetry'), false);
  const reply = { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] };
  pending.get(flash.id)!(reply);
  await flush();
  assert.match(render(), /Flash ✓.*in 153[.]9k.*fast ○/s);
  publish('compact', { tokens: 200_000, limit: 300_000, contextWindow: 1_000_000 });
  publish('fast', 'on');
  assert.match(render(), /Flash ✓.*in 100k.*fast ●/s);
  pending.get(sol.id)!(reply);
  await flush();
  models = [];
  t.mock.timers.tick(60_000);
  await flush();
  publish('fast', 'on');
  assert.doesNotMatch(render(), /hms\/|xingchi\//);
  assert.match(render(), /compact.*fast/);
  assert.match(render(), /in 100k.*fast ●/);
  models = [flash, sol];
  await h.event('agent_settled');
  assert.match(render(), /Flash ○.*Sol ○.*in 100k.*fast ●/s);
  h.ctx.model = { provider: 'other', id: 'test' } as typeof h.ctx.model;
  await h.event('model_select');
  publish('fast', 'n/a', ':other/test');
  assert.doesNotMatch(render(), /compact/);
  assert.match(render(), /fast —/);
  await h.event('session_shutdown');
  for (const finish of pending.values()) finish(reply);
  await flush();
  assert.equal(widgets.has('usage-model-health'), false);
});
