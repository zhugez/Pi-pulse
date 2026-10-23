import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Provider, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

interface Account { key: string; cooldownUntil?: number; disabled?: boolean }
interface Config { baseUrl: string; keys: string[]; models: Model<"openai-completions">[] }
const ID = "alpakyros-pool";

export function createPoolStream(accounts: Account[], delegate = builtinProviders().find((provider) => provider.id === "deepseek")!.streamSimple) {
  // ponytail: cooldowns and sticky account are process-local; persist only if cross-session coordination is needed.
  let preferred = 0;
  return (model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    const outer = createAssistantMessageEventStream();
    let output: AssistantMessage = {
      role: "assistant", content: [], api: model.api, provider: ID, model: model.id,
      timestamp: Date.now(), stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const fail = (message: string, aborted = false) => {
      output = { ...output, stopReason: aborted ? "aborted" : "error", errorMessage: message };
      outer.push({ type: "error", reason: aborted ? "aborted" : "error", error: output });
    };
    void (async () => {
      try {
        for (let offset = 0, start = preferred; offset < accounts.length; offset++) {
          options?.signal?.throwIfAborted();
          const index = (start + offset) % accounts.length;
          const account = accounts[index];
          if (account.disabled || (account.cooldownUntil ?? 0) > Date.now()) continue;
          let status = 0;
          let retryMs = 60_000;
          let committed = false;
          let startEvent: Parameters<typeof outer.push>[0] | undefined;
          let terminal = false;
          const inner = delegate({ ...model, api: "openai-completions" }, context, {
            ...options, apiKey: account.key,
            // Override any ambient authentication header so each attempt uses its selected key.
            headers: { ...options?.headers, Authorization: `Bearer ${account.key}` },
            fetch: async (input, init) => {
              const response = await (options?.fetch ?? globalThis.fetch)(input, init);
              status = response.status;
              const retry = response.headers.get("retry-after");
              const seconds = retry === null ? NaN : Number(retry);
              const until = retry === null ? NaN : Date.parse(retry);
              if (Number.isFinite(seconds)) retryMs = Math.max(1000, seconds * 1000);
              else if (Number.isFinite(until)) retryMs = Math.max(1000, until - Date.now());
              return response;
            },
          });
          for await (const event of inner) {
            if (event.type === "error") {
              output = structuredClone(event.error);
              terminal = true;
              break;
            }
            if (event.type === "done") {
              output = structuredClone(event.message);
              preferred = index;
              if (startEvent) outer.push(startEvent);
              outer.push({ ...event, message: output });
              return;
            }
            if ("partial" in event) output = structuredClone(event.partial);
            if (event.type === "start") { startEvent = structuredClone(event); continue; }
            // Any content/tool event commits this attempt, even an empty tool-call start.
            if (startEvent) { outer.push(startEvent); startEvent = undefined; }
            committed = true;
            outer.push(structuredClone(event));
          }
          if (options?.signal?.aborted || output.stopReason === "aborted") {
            fail("Alpakyros request cancelled.", true);
            return;
          }
          const quota = status === 429;
          const auth = status === 401 || status === 403;
          if (quota) account.cooldownUntil = Date.now() + retryMs;
          if (auth) account.disabled = true;
          if (committed || !terminal || (!quota && !auth)) {
            const overflow = /context_length_exceeded|maximum context length/i.test(output.errorMessage ?? "");
            fail(committed ? "Alpakyros stream interrupted; replay suppressed." :
              overflow ? "context_length_exceeded" : "Alpakyros request failed; no account replay performed.");
            return;
          }
          // Failed attempts had no content. The next key gets at most one attempt.
          preferred = (index + 1) % accounts.length;
        }
        fail("Alpakyros pool exhausted: keys require replacement or are cooling down.");
      } catch {
        fail(options?.signal?.aborted ? "Alpakyros request cancelled." :
          "Alpakyros request failed; no account replay performed.", !!options?.signal?.aborted);
      } finally { outer.end(); }
    })();
    return outer;
  };
}

export default function alpakyrosPool(pi: ExtensionAPI) {
  const file = join(getAgentDir(), "alpakyros-pool.json");
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Cannot open private alpakyros-pool.json.");
  }
  let config: Config;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error();
    config = JSON.parse(readFileSync(fd, "utf8"));
    const url = new URL(config.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        !Array.isArray(config.keys) || !config.keys.length ||
        config.keys.some((key) => typeof key !== "string" || !key.trim()) ||
        !Array.isArray(config.models) || !config.models.length ||
        config.models.some((m) => typeof m.id !== "string" || !m.id ||
          !Number.isSafeInteger(m.contextWindow) || m.contextWindow <= 0 ||
          !Number.isSafeInteger(m.maxTokens) || m.maxTokens <= 0)) throw new Error();
  } catch { throw new Error("Invalid private alpakyros-pool.json (requires owner-only 0600 file)."); }
  finally { closeSync(fd); }
  const models = config.models.map((model) => ({ ...model, type: "chat" as const,
    api: "openai-completions" as const, provider: ID, baseUrl: config.baseUrl,
    name: model.id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  const stream = createPoolStream([...new Set(config.keys)].map((key) => ({ key })));
  const provider: Provider = {
    id: ID, name: "Alpakyros Pool", baseUrl: config.baseUrl,
    auth: { apiKey: {
      name: "Alpakyros pool keys",
      check: async () => ({ source: "Private key pool", type: "api_key" }),
      resolve: async () => ({ auth: { apiKey: "pool-managed" }, source: "Private key pool" }),
    } },
    getModels: () => models,
    streamSimple: stream,
    stream: (model, context, options) => stream(model, context, options as SimpleStreamOptions),
  };
  (pi.registerProvider as (provider: unknown) => void)(provider);
}
