import { wbFetch } from "./nodefetch.ts";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { ensureFreshAccount } from "./auth.ts";
import type { WbCatalog } from "./catalog.ts";
import { chatHeaders, newChatMeta } from "./headers.ts";
import { prepareBody } from "./payload.ts";
import { accountBase, type AccountStore, type WbAccount } from "./store.ts";

const CHAT_PATH = "/v2/chat/completions";
const COOLDOWN_MS = 120_000;
const MAX_REPLAY_BYTES = 1_000_000;

/** Errors that mean "this account/model pair cannot serve this request right now". */
const ROTATE_CODES = new Set(["11102", "11158", "11-128", "11133", "11129", "429", "401", "403", "500", "502", "503", "504"]);
const MODEL_RATE_LIMIT_CODE = "6004";
const QUOTA_CODES = new Set(["429", "insufficient_credit", "quota_exceeded"]);

export interface TransportOptions {
  store: AccountStore;
  catalog: () => WbCatalog | undefined;
  /** Optional upstream fetch seam for deterministic tests. */
  upstreamFetch?: FetchFunction;
  /** Called with the uid that actually served a request. */
  onAccount?: (uid: string) => void;
  maxAttempts?: number;
}

export interface TransportStats {
  lastAccount?: string;
  lastStatus?: number;
  attempts: number;
}

function headersToObject(init?: unknown): Record<string, string> {
  if (!init) return {};
  if (init instanceof Headers) return Object.fromEntries(init.entries());
  if (Array.isArray(init)) return Object.fromEntries(init);
  return { ...(init as Record<string, string>) };
}

function errorCode(text: string): string {
  try {
    const parsed = JSON.parse(text) as { code?: unknown; msg?: string };
    if (typeof parsed.code === "number" || typeof parsed.code === "string") return String(parsed.code);
  } catch {
    /* not JSON */
  }
  return "";
}

function modelRateLimit(text: string): boolean {
  return errorCode(text) === MODEL_RATE_LIMIT_CODE;
}

function parseResetAt(text: string): number | undefined {
  const match = text.match(/reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC\+8/i);
  if (!match) return undefined;
  const value = Date.parse(`${match[1].replace(" ", "T")}+08:00`);
  return Number.isFinite(value) ? value : undefined;
}

function rotateEligible(status: number, text: string): boolean {
  if (status === 400) return ROTATE_CODES.has(errorCode(text));
  return ROTATE_CODES.has(String(status));
}

function quotaFailure(status: number, text: string): boolean {
  const code = errorCode(text);
  if (QUOTA_CODES.has(code) || QUOTA_CODES.has(String(status))) return true;
  return /credit|quota|额度|余额/i.test(text);
}

function authFailure(status: number, text: string): boolean {
  return status === 401 || status === 403 || /re-?login|unauthor/i.test(text);
}

function usable(account: WbAccount, now: number, model: string): boolean {
  if (account.needsLogin) return false;
  if (account.cooldownUntil && account.cooldownUntil > now) return false;
  const until = model ? account.modelCooldowns?.[model] : undefined;
  return !until || until <= now;
}

/** Prefer accounts with credit headroom; stable order keeps behaviour predictable. */
function candidates(accounts: WbAccount[], now: number, model: string): WbAccount[] {
  const modelPool = accounts.filter((account) => usable(account, now, model) || (model && !account.needsLogin && !account.modelCooldowns?.[model]));
  const live = modelPool.filter((account) => usable(account, now, model));
  const pool = live.length > 0 ? live : model ? modelPool : accounts.filter((account) => !account.needsLogin);
  return [...pool].sort((a, b) => (b.credit ?? 0) - (a.credit ?? 0));
}

function nextModelReset(accounts: WbAccount[], now: number, model: string): number | undefined {
  if (!model) return undefined;
  return accounts
    .map((account) => account.modelCooldowns?.[model])
    .filter((until): until is number => typeof until === "number" && until > now)
    .sort((a, b) => a - b)[0];
}

/**
 * Custom fetch injected into pi's openai-completions adapter: it owns WorkBuddy's
 * headers, outbound body rewriting and account rotation, and lets the adapter keep
 * SSE parsing, tool-call assembly and usage accounting.
 */
export function createWorkBuddyFetch(options: TransportOptions): { fetch: FetchFunction; stats: TransportStats } {
  const stats: TransportStats = { attempts: 0 };

  const wrapped: FetchFunction = async (input, init) => {
    const requestFetch = options.upstreamFetch ?? wbFetch();
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!requestUrl.includes(CHAT_PATH)) return requestFetch(input as string | URL | Request, init);

    const originalBody = typeof init?.body === "string" ? init.body : "";
    if (originalBody.length > MAX_REPLAY_BYTES) {
      return new Response(JSON.stringify({ error: { message: "WorkBuddy request body exceeds replay limit" } }), { status: 413 });
    }
    const incoming = headersToObject(init?.headers);
    const sessionId = incoming["x-client-request-id"] || incoming["x-session-affinity"] || "";
    const catalog = options.catalog();
    let parsed: unknown;
    try {
      parsed = JSON.parse(originalBody);
    } catch {
      parsed = undefined;
    }
    const model = typeof (parsed as { model?: unknown } | undefined)?.model === "string"
      ? String((parsed as { model: string }).model)
      : "";
    const data = await options.store.read();
    const ordered = candidates(data.accounts, Date.now(), model);
    if (ordered.length === 0) {
      const resetAt = nextModelReset(data.accounts, Date.now(), model);
      const message = resetAt
        ? `WorkBuddy model ${model} is cooling down until ${new Date(resetAt).toISOString()}`
        : "No WorkBuddy account configured. Run /workbuddy login.";
      return new Response(JSON.stringify({ error: { message } }), {
        status: resetAt ? 409 : 401,
        headers: { "content-type": "application/json" },
      });
    }

    const maxAttempts = Math.min(options.maxAttempts ?? 3, ordered.length);
    let lastResponse: Response | undefined;
    let lastText = "";

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const raw = ordered[attempt];
      let account: WbAccount;
      try {
        account = await ensureFreshAccount(options.store, raw, init?.signal ?? undefined);
      } catch (error) {
        if (attempt + 1 >= maxAttempts) throw error;
        continue;
      }
      stats.attempts += 1;
      const meta = newChatMeta(sessionId || undefined);
      const body = prepareBody(parsed ?? originalBody, {
        model,
        efforts: catalog?.efforts,
        defaultEfforts: catalog?.defaultEfforts,
        uid: account.uid,
        realm: account.realm,
        conversationId: meta.conversationId,
        ensureSystem: account.realm === "global",
      });

      // Realm decides the host (workbuddy.ai vs workbuddy.cn); keep the adapter's path.
      const path = new URL(requestUrl).pathname;
      const target = `${accountBase(account)}${path}`;
      let response: Response;
      try {
        response = await requestFetch(target, {
          method: "POST",
        headers: { ...chatHeaders(account, meta), "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
          signal: init?.signal ?? undefined,
        });
      } catch (error) {
        if (init?.signal?.aborted) throw error;
        if (attempt + 1 >= maxAttempts) throw error;
        continue;
      }
      stats.lastAccount = account.uid;
      stats.lastStatus = response.status;
      if (response.ok) {
        options.onAccount?.(account.uid);
        return response;
      }

      lastText = await response.text();
      lastResponse = new Response(lastText, { status: response.status, headers: response.headers });
      if (modelRateLimit(lastText)) {
        const until = parseResetAt(lastText) ?? Date.now() + COOLDOWN_MS;
        await options.store.update((store) => {
          const current = store.accounts.find((a) => a.uid === account.uid);
          if (!current) return;
          current.modelCooldowns = { ...current.modelCooldowns, [model]: until };
        });
      } else if (quotaFailure(response.status, lastText)) {
        await options.store.update((store) => {
          const current = store.accounts.find((a) => a.uid === account.uid);
          if (current) current.cooldownUntil = Date.now() + COOLDOWN_MS;
        });
      } else if (authFailure(response.status, lastText)) {
        await options.store.update((store) => {
          const current = store.accounts.find((a) => a.uid === account.uid);
          if (current) current.needsLogin = true;
        });
      }
      if (!rotateEligible(response.status, lastText)) break;
    }

    if (lastResponse) {
      const state = await options.store.read();
      if (modelRateLimit(lastText) && candidates(state.accounts, Date.now(), model).length === 0) {
        const resetAt = nextModelReset(state.accounts, Date.now(), model);
        const message = resetAt
          ? `WorkBuddy model ${model} is cooling down until ${new Date(resetAt).toISOString()}`
          : `WorkBuddy model ${model} is cooling down`;
        return new Response(JSON.stringify({ error: { message } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return lastResponse;
    }
    return new Response(JSON.stringify({ error: { message: "WorkBuddy request failed without a response" } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch: wrapped, stats };
}
