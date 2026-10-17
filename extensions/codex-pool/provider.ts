import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { AccountStore, accountIdentity, PoolError, type Account } from "./store.ts";

export const PROVIDER_ID = "codex-pool";
const COOLDOWN_MS = 60_000;
const marker = (): OAuthCredential => ({
  type: "oauth", access: "codex-pool-managed", refresh: "codex-pool-managed", expires: 8_640_000_000_000_000,
});

function emptyMessage(model: Model<string>): AssistantMessage {
  return {
    role: "assistant", provider: PROVIDER_ID, api: model.api, model: model.id,
    timestamp: Date.now(), content: [], stopReason: "pending",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function meaningful(event: AssistantMessageEvent): boolean {
  if (event.type.startsWith("toolcall_")) return true;
  if ((event.type === "text_delta" || event.type === "thinking_delta") && event.delta.length > 0) return true;
  if ((event.type === "text_end" || event.type === "thinking_end") && event.content.length > 0) return true;
  const message = "partial" in event ? event.partial : event.type === "error" ? event.error : undefined;
  return !!message?.content.some((block) => block.type === "toolCall" ||
    (block.type === "text" ? block.text.length > 0 : block.type === "thinking" && block.thinking.length > 0));
}

function snapshotMessage(message: AssistantMessage): AssistantMessage {
  const clone = structuredClone(message);
  clone.provider = PROVIDER_ID;
  delete clone.errorMessage;
  delete clone.diagnostics;
  for (const block of clone.content) {
    delete (block as { partialJson?: unknown }).partialJson;
    delete (block as { customInput?: unknown }).customInput;
  }
  return clone;
}

function snapshotEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  if ("partial" in event) {
    const snap: AssistantMessageEvent = { ...event, partial: snapshotMessage(event.partial) };
    if (event.type === "toolcall_end") {
      (snap as { toolCall: unknown }).toolCall = structuredClone(event.toolCall);
    }
    return snap;
  }
  if (event.type === "done") {
    const message = snapshotMessage(event.message);
    message.stopReason = event.message.stopReason;
    return { ...event, message };
  }
  return event;
}

function quotaError(message: string): boolean {
  return /\b(?:usage_limit_reached|usage_not_included|rate_limit_exceeded)\b/i.test(message);
}

export function cooldownUntil(headers: Headers, resetAt?: number, now = Date.now()): number {
  const deadlines: number[] = [];
  const millis = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(millis) && millis >= 0) deadlines.push(now + millis);
  const retry = headers.get("retry-after");
  if (retry !== null) {
    const seconds = Number(retry);
    const deadline = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(retry);
    if (Number.isFinite(deadline)) deadlines.push(deadline);
  }
  if (resetAt !== undefined && Number.isFinite(resetAt)) deadlines.push(resetAt * 1000);
  // Past/zero reset hints still need a small cooldown to avoid hot loops.
  return Math.max(now + 1000, ...(deadlines.length ? deadlines : [now + COOLDOWN_MS]));
}

// Bound error bodies independently of the SDK's header/stream idle timeout.
async function readErrorBody(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const guard = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
  let rejectAbort: (error: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error("Codex error body cancelled"));
  guard.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    guard.throwIfAborted();
    while (size < 16_384) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      const chunk = next.value.subarray(0, 16_384 - size);
      chunks.push(chunk);
      size += chunk.length;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    guard.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  }
}

// native is injectable only at the SDK boundary: tests exercise registration,
// Models auth resolution and the real Codex HTTP/SSE adapter without credentials.
export function createCodexPool(store: AccountStore, native: Provider = openaiCodexProvider()) {
  const oauth = native.auth.oauth;
  if (!oauth) throw new PoolError("This Pi SDK has no native Codex OAuth support.");
  const sticky = new Map<string, string>();
  const remember = (session: string, id: string) => {
    sticky.delete(session);
    sticky.set(session, id);
    if (sticky.size > 256) sticky.delete(sticky.keys().next().value!);
  };

  async function add(interaction: Parameters<OAuthAuth["login"]>[0]): Promise<string> {
    try {
      const credential = await oauth!.login(interaction);
      interaction.signal.throwIfAborted();
      return await store.add(credential, interaction.signal);
    } catch (error) {
      if (error instanceof PoolError) throw error;
      throw new PoolError(interaction.signal.aborted ? "Codex login cancelled." : "Codex login failed. Try again using Pi's OAuth flow.");
    }
  }

  async function select(allowed: Set<string>, tried: Set<string>, session: string, signal?: AbortSignal): Promise<Account | undefined> {
    return store.update(async (data) => {
      const available = data.accounts.filter((a) => allowed.has(a.id) && !tried.has(a.id) &&
        !a.needsLogin && (a.cooldownUntil ?? 0) <= Date.now());
      const account = available.find((a) => a.id === sticky.get(session)) ??
        available.find((a) => a.id === data.preferred) ?? available[0];
      if (!account) return undefined;
      tried.add(account.id);
      if (account.credential.expires <= Date.now() + 30_000) {
        account.needsLogin = true;
        await store.save(data);
        try {
          const refreshed = await oauth!.refresh(account.credential, AbortSignal.any([
            ...(signal ? [signal] : []), AbortSignal.timeout(15_000),
          ]));
          if (accountIdentity(refreshed) !== account.id || refreshed.expires <= Date.now() + 30_000) throw new Error();
          account.credential = refreshed;
          delete account.needsLogin;
        } catch {
          // A failed/interrupted exchange may already have rotated the token.
          // Fail closed until login instead of repeatedly spending the old token.
          account.needsLogin = true;
          return undefined;
        }
      }
      return structuredClone(account);
    }, signal);
  }

  function stream(model: Model<string>, context: TranscriptContext, options?: StreamOptions, simple = true) {
    const outer = createAssistantMessageEventStream();
    let output = emptyMessage(model);
    let committed = false;
    const buffered: AssistantMessageEvent[] = [];
    const finish = (message: string, aborted = false, diagnostics?: AssistantMessage["diagnostics"]) => {
      const errorOutput: AssistantMessage = {
        ...snapshotMessage(output),
        stopReason: aborted ? "aborted" : "error",
        errorMessage: message,
        ...(diagnostics ? { diagnostics: structuredClone(diagnostics) } : {}),
      };
      output = errorOutput;
      outer.push({ type: "error", reason: aborted ? "aborted" : "error", error: errorOutput });
    };
    void (async () => {
      try {
        options?.signal?.throwIfAborted();
        const allowed = new Set((await store.read()).accounts.map((a) => a.id));
        const tried = new Set<string>();
        const session = options?.sessionId ?? "runtime";
        while (tried.size < allowed.size) {
          options?.signal?.throwIfAborted();
          const previousSize = tried.size;
          const account = await select(allowed, tried, session, options?.signal);
          options?.signal?.throwIfAborted();
          if (!account) {
            if (tried.size > previousSize) continue; // failed refresh, try the next ID
            break;
          }
          remember(session, account.id);
          let status = 0;
          let headers = new Headers();
          let code = "";
          let resetAt: number | undefined;
          const fetcher = options?.fetch ?? globalThis.fetch;
          const streamOptions = options as (SimpleStreamOptions & {
            onProviderStreamEvent?: (event: unknown, model: Model<string>) => void | Promise<void>;
          }) | undefined;
          const innerOptions = {
            ...options, apiKey: account.credential.access,
            onPayload: (payload: unknown) => options?.onPayload?.(payload, model),
            onResponse: (response: Parameters<NonNullable<SimpleStreamOptions["onResponse"]>>[0]) => options?.onResponse?.(response, model),
            onProviderStreamEvent: (event: unknown) => {
              if (event && typeof event === "object") {
                const raw = event as {
                  type?: unknown;
                  code?: unknown;
                  message?: unknown;
                  error?: { code?: unknown; type?: unknown; message?: unknown; resets_at?: unknown };
                  response?: { error?: { code?: unknown; type?: unknown; message?: unknown; resets_at?: unknown } };
                  resets_at?: unknown;
                };
                const err = raw.error ?? raw.response?.error;
                const rawCode = err?.code ?? err?.type ?? (raw.type === "error" ? raw.code : undefined);
                if (typeof rawCode === "string") code = rawCode;
                const resetValue = err?.resets_at ?? raw.resets_at;
                if (typeof resetValue === "number") resetAt = resetValue;
                const errMessage = err?.message ?? (typeof raw.message === "string" ? raw.message : undefined);
                if (typeof errMessage === "string" && quotaError(errMessage) && !code) {
                  code = errMessage;
                }
              }
              return streamOptions?.onProviderStreamEvent?.(event, model);
            },
            // SSE avoids hidden WebSocket reconnect/replay and exposes HTTP status.
            // Keep the native request conversion, headers, tools, usage and hooks.
            transport: "sse" as const, maxRetries: 0,
            fetch: async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
              const response = await fetcher(input, { ...init, signal: AbortSignal.any([
                ...(init?.signal ? [init.signal] : []), ...(options?.signal ? [options.signal] : []),
              ]) });
              status = response.status;
              headers = response.headers;
              if (!response.ok) {
                const text = await readErrorBody(response, options?.signal);
                try {
                  const body = JSON.parse(text) as {
                    error?: { code?: unknown; type?: unknown; message?: unknown; resets_at?: unknown };
                    resets_at?: unknown;
                  };
                  const error = body.error;
                  const rawCode = error?.code ?? error?.type;
                  if (typeof rawCode === "string") code = rawCode;
                  const resetValue = error?.resets_at ?? body.resets_at;
                  if (typeof resetValue === "number") resetAt = resetValue;
                  const errMessage = error?.message;
                  if (typeof errMessage === "string" && quotaError(errMessage) && !code) {
                    code = errMessage;
                  }
                } catch { /* native adapter owns malformed error reporting */ }
                return new Response(text, { status, headers });
              }
              if (response.body) {
                const decoder = new TextDecoder();
                let buffer = "";
                const processFrame = (frame: string) => {
                  const lines = frame.split(/\r?\n/);
                  const dataLines: string[] = [];
                  for (const line of lines) {
                    if (line.startsWith("data:")) {
                      dataLines.push(line.slice(5).trimStart());
                    }
                  }
                  if (dataLines.length === 0) return;
                  const jsonText = dataLines.join("\n").trim();
                  if (!jsonText || jsonText === "[DONE]") return;
                  try {
                    const data = JSON.parse(jsonText) as {
                      type?: unknown;
                      code?: unknown;
                      message?: unknown;
                      error?: { code?: unknown; type?: unknown; message?: unknown; resets_at?: unknown };
                      response?: { error?: { code?: unknown; type?: unknown; message?: unknown; resets_at?: unknown } };
                      resets_at?: unknown;
                    };
                    const err = data.error ?? data.response?.error;
                    const rawCode = err?.code ?? err?.type ?? (data.type === "error" ? data.code : undefined);
                    if (typeof rawCode === "string") code = rawCode;
                    const resetValue = err?.resets_at ?? data.resets_at;
                    if (typeof resetValue === "number") resetAt = resetValue;
                    const errMessage = err?.message ?? (typeof data.message === "string" ? data.message : undefined);
                    if (typeof errMessage === "string" && quotaError(errMessage) && !code) {
                      code = errMessage;
                    }
                  } catch { /* ignore non-JSON SSE frames */ }
                };
                const transform = new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, controller) {
                    controller.enqueue(chunk);
                    try {
                      buffer += decoder.decode(chunk, { stream: true });
                      let match: RegExpExecArray | null;
                      while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
                        const frame = buffer.slice(0, match.index);
                        buffer = buffer.slice(match.index + match[0].length);
                        processFrame(frame);
                      }
                    } catch { /* ignore parsing errors */ }
                  },
                  flush() {
                    try {
                      buffer += decoder.decode();
                      if (buffer.trim()) {
                        processFrame(buffer);
                      }
                    } catch { /* ignore flush errors */ }
                  },
                });
                return new Response(response.body.pipeThrough(transform), { status, headers });
              }
              return response;
            },
          };
          // Native conversion recognizes its provider ID when preserving tool IDs
          // and encrypted reasoning. Translate only our own transcript messages.
          const nativeModel = { ...model, provider: "openai-codex" };
          const nativeContext = { ...context, messages: context.messages.map((message) =>
            message.role === "assistant" && message.provider === PROVIDER_ID
              ? { ...message, provider: "openai-codex" } : message) };
          const inner = simple ? native.streamSimple(nativeModel, nativeContext, innerOptions) : native.stream(nativeModel, nativeContext, innerOptions);
          let terminal: AssistantMessageEvent | undefined;
          try {
            for await (const event of inner) {
              if (event.type === "error" || event.type === "done") { terminal = event; break; }
              if ("partial" in event) output = event.partial;
              const snap = snapshotEvent(event);
              if (!committed) {
                buffered.push(snap);
                if (meaningful(snap)) {
                  committed = true;
                  for (const pending of buffered) outer.push(pending);
                  buffered.length = 0;
                }
              } else outer.push(snap);
            }
          } catch (streamError) {
            output.errorMessage = streamError instanceof Error ? streamError.message : String(streamError);
          }
          if (terminal?.type === "done" && !options?.signal?.aborted) {
            for (const pending of buffered) outer.push(pending);
            buffered.length = 0;
            outer.push(snapshotEvent(terminal));
            return;
          }
          if (terminal?.type === "error") output = terminal.error;
          if (options?.signal?.aborted || (terminal?.type === "error" && terminal.reason === "aborted")) {
            finish("Codex request cancelled.", true);
            return;
          }
          committed ||= terminal ? meaningful(terminal) : meaningful({ type: "error", error: output, reason: "error" });
          const quota = status === 429 || quotaError(code) || quotaError(output.errorMessage ?? "");
          const auth = !quota && (status === 401 || status === 403);
          if (quota || auth) {
            await store.update((data) => {
              const current = data.accounts.find((a) => a.id === account.id);
              // A concurrent login/refresh must not be invalidated by an old response.
              if (!current || current.credential.refresh !== account.credential.refresh) return;
              if (auth) current.needsLogin = true;
              else current.cooldownUntil = cooldownUntil(headers, resetAt);
            }, options?.signal);
          }
          if (committed) {
            finish("Codex response interrupted after output; automatic replay suppressed.");
            return;
          }
          if (!quota && !auth) {
            // Preserve context-overflow handling, but not raw error payloads/secrets.
            const overflow = /context_length_exceeded|maximum context length/i.test(output.errorMessage ?? "");
            finish(overflow ? "context_length_exceeded" : "Codex request failed; no account replay performed.");
            return;
          }
          buffered.length = 0;
          output = emptyMessage(model);
        }
        const poolData = await store.read();
        const activeCooldowns = poolData.accounts
          .map((a) => a.cooldownUntil)
          .filter((c): c is number => typeof c === "number" && c > Date.now());
        let exhaustionMessage = "Codex pool exhausted: accounts need login or are cooling down. Use /codex-pool.accounts list.";
        let diagnostics: AssistantMessage["diagnostics"] | undefined;
        if (activeCooldowns.length > 0) {
          const earliestReset = Math.min(...activeCooldowns);
          const waitMs = Math.max(0, earliestReset - Date.now());
          const waitSec = Math.ceil(waitMs / 1000);
          const resetLabel = waitSec >= 60 ? `~${Math.ceil(waitSec / 60)}m` : `~${waitSec}s`;
          exhaustionMessage = `Codex pool exhausted: accounts need login or are cooling down (earliest reset in ${resetLabel}). Use /codex-pool.accounts list.`;
          diagnostics = [{
            type: "codex_pool_exhausted",
            timestamp: Date.now(),
            details: {
              accountsTotal: poolData.accounts.length,
              coolingDown: activeCooldowns.length,
              earliestResetMs: waitMs,
            },
          }];
        }
        finish(exhaustionMessage, false, diagnostics);
      } catch (error) {
        finish(options?.signal?.aborted ? "Codex request cancelled." :
          error instanceof PoolError ? error.message : "Codex pool operation failed; no account replay performed.", !!options?.signal?.aborted);
      } finally {
        outer.end();
      }
    })();
    return outer;
  }

  const available = async () => (await store.read()).accounts.length > 0;
  const provider: Provider = {
    id: PROVIDER_ID, name: "Codex Pool", baseUrl: native.baseUrl,
    auth: {
      apiKey: {
        name: "Codex pool accounts",
        check: async () => await available() ? { source: "Codex pool", type: "oauth" } : undefined,
        resolve: async () => await available() ? { auth: { apiKey: "codex-pool-managed" }, source: "OAuth" } : undefined,
      },
      oauth: {
        name: "Codex Pool (ChatGPT)", isSubscription: true,
        login: async (interaction) => { await add(interaction); return marker(); },
        refresh: async () => marker(),
        toAuth: async () => ({ apiKey: "codex-pool-managed" }),
      },
    },
    getModels: () => native.getModels().map((model) => ({ ...model, provider: PROVIDER_ID })),
    streamSimple: (model, context, options) => stream(model, context, options),
    stream: (model, context, options) => stream(model, context, options, false),
  };
  return { provider, add, clearSticky: () => sticky.clear() };
}
