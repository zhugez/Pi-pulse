/**
 * Outbound request rewriting for the WorkBuddy upstream.
 *
 * Ported from workbuddy2api-panel internal/upstream (payload.go, tool_pairing.go,
 * thinking.go, cache_key.go). Every rule here exists because upstream returned a
 * specific 400/503 without it; keep them in sync with the Go source.
 */
import { createHash } from "node:crypto";
import type { Realm } from "./store.ts";

type Json = Record<string, unknown>;

const EFFORT_RANK: Record<string, number> = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };
const DEFAULT_DEEPSEEK_EFFORT = "high";
const GPT_MIN_MAX_TOKENS = 16;

export interface PrepareOptions {
  /** Model id the request targets (used for effort clamping and thinking rules). */
  model: string;
  /** Supported reasoning efforts per model, as advertised by upstream. */
  efforts?: Record<string, string[]>;
  defaultEfforts?: Record<string, string>;
  /** Account uid: isolates the upstream prompt cache per account. */
  uid: string;
  /** WorkBuddy realm; global DeepSeek V4.1 Flash only accepts high effort. */
  realm?: Realm;
  conversationId?: string;
  /** global realm requires a leading system message (upstream code 11-128). */
  ensureSystem?: boolean;
}

function isDeepSeek(model: string): boolean {
  return model.toLowerCase().includes("deepseek");
}

function emptyContent(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function toolCallNameEmpty(call: Json): boolean {
  const fn = call.function;
  if (!fn || typeof fn !== "object") return false;
  const name = (fn as Json).name;
  if (typeof name !== "string") return false;
  return name.trim() === "";
}

function mergeReasoningContent(dst: Json, src: Json): void {
  const rc = typeof src.reasoning_content === "string" ? src.reasoning_content : "";
  if (!rc) return;
  const previous = typeof dst.reasoning_content === "string" ? dst.reasoning_content : "";
  dst.reasoning_content = previous ? `${previous}\n${rc}` : rc;
}

/** Back-to-back `assistant(tool_calls)` messages break deepseek (upstream 11148). */
export function mergeAdjacentToolCalls(messages: unknown[]): { messages: unknown[]; changed: boolean } {
  if (messages.length < 2) return { messages, changed: false };
  const out: unknown[] = [];
  let changed = false;
  for (const raw of messages) {
    const msg = raw as Json;
    if (!msg || typeof msg !== "object" || msg.role !== "assistant") {
      out.push(raw);
      continue;
    }
    const calls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as unknown[]) : undefined;
    const prev = out.at(-1) as Json | undefined;
    const prevIsAssistantWithCalls = prev && prev.role === "assistant"
      && Array.isArray(prev.tool_calls) && (prev.tool_calls as unknown[]).length > 0;
    if (calls && calls.length > 0 && emptyContent(msg.content) && prevIsAssistantWithCalls) {
      prev!.tool_calls = [...(prev!.tool_calls as unknown[]), ...calls];
      mergeReasoningContent(prev!, msg);
      changed = true;
      continue;
    }
    if (!calls && typeof msg.content === "string" && msg.content !== "" && prevIsAssistantWithCalls && emptyContent(prev!.content)) {
      prev!.content = msg.content;
      mergeReasoningContent(prev!, msg);
      changed = true;
      continue;
    }
    out.push(raw);
  }
  return { messages: changed ? out : messages, changed };
}

/** Move messages wedged between an assistant.tool_calls batch and its results. */
export function repackToolResultBlocks(messages: unknown[]): { messages: unknown[]; changed: boolean } {
  if (messages.length < 3) return { messages, changed: false };
  const out: unknown[] = [];
  let changed = false;
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i] as Json;
    if (!msg || typeof msg !== "object" || msg.role !== "assistant") {
      out.push(messages[i]);
      i += 1;
      continue;
    }
    const calls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as unknown[]) : [];
    if (calls.length === 0) {
      out.push(messages[i]);
      i += 1;
      continue;
    }
    const want = new Set<string>();
    for (const call of calls) {
      const id = (call as Json)?.id;
      if (typeof id === "string" && id) want.add(id);
    }
    out.push(messages[i]);
    i += 1;
    const results: unknown[] = [];
    const between: unknown[] = [];
    let sawNonTool = false;
    while (i < messages.length) {
      const next = messages[i] as Json;
      if (!next || typeof next !== "object") break;
      if (next.role === "tool") {
        const id = typeof next.tool_call_id === "string" ? next.tool_call_id : "";
        if (!want.has(id)) break;
        results.push(messages[i]);
        if (sawNonTool) changed = true;
        i += 1;
        continue;
      }
      if (results.length === 0) break;
      // A following assistant(tool_calls) is a new group header, never filler.
      if (next.role === "assistant" && Array.isArray(next.tool_calls) && (next.tool_calls as unknown[]).length > 0) break;
      between.push(messages[i]);
      sawNonTool = true;
      i += 1;
    }
    out.push(...results, ...between);
  }
  return { messages: changed ? out : messages, changed };
}

/** Drop tool_calls without results and tool results without calls (upstream 11148). */
export function cleanupOrphanToolCalls(messages: unknown[]): { messages: unknown[]; changed: boolean } {
  if (messages.length === 0) return { messages, changed: false };
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  const badNameIds = new Set<string>();
  let hasTraffic = false;
  for (const raw of messages) {
    const msg = raw as Json;
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "tool") {
      const id = msg.tool_call_id;
      if (typeof id === "string" && id) {
        resultIds.add(id);
        hasTraffic = true;
      }
    } else if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const rawCall of msg.tool_calls as unknown[]) {
        const call = rawCall as Json;
        if (!call || typeof call !== "object") continue;
        const id = call.id;
        if (typeof id === "string" && id) {
          callIds.add(id);
          if (toolCallNameEmpty(call)) badNameIds.add(id);
          hasTraffic = true;
        }
      }
    }
  }
  if (!hasTraffic) return { messages, changed: false };

  const keep = new Set<string>();
  for (const id of callIds) if (!badNameIds.has(id) && resultIds.has(id)) keep.add(id);

  let changed = false;
  for (const raw of messages) {
    const msg = raw as Json;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    const calls = msg.tool_calls as unknown[];
    if (calls.length === 0) continue;
    const kept = calls.filter((rawCall) => {
      const id = (rawCall as Json)?.id;
      return typeof id === "string" && keep.has(id);
    });
    if (kept.length === calls.length) continue;
    changed = true;
    if (kept.length === 0) delete msg.tool_calls;
    else msg.tool_calls = kept;
  }

  const filtered = messages.filter((raw) => {
    const msg = raw as Json;
    if (!msg || typeof msg !== "object" || msg.role !== "tool") return true;
    const id = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
    if (keep.has(id)) return true;
    changed = true;
    return false;
  });
  return changed ? { messages: filtered, changed } : { messages, changed: false };
}

function translateMaxCompletionTokens(body: Json): void {
  if (!("max_completion_tokens" in body)) return;
  const alias = body.max_completion_tokens;
  delete body.max_completion_tokens;
  if ("max_tokens" in body) return;
  if (typeof alias === "number" && Number.isInteger(alias) && alias > 0) body.max_tokens = alias;
}

function clampGptMinMaxTokens(body: Json): void {
  const model = typeof body.model === "string" ? body.model.toLowerCase() : "";
  if (!model.includes("gpt-")) return;
  const value = body.max_tokens;
  if (typeof value !== "number") return;
  if (value < GPT_MIN_MAX_TOKENS) body.max_tokens = GPT_MIN_MAX_TOKENS;
}

/** Upstream types tool_choice as a plain string; objects are rejected (11101). */
function normalizeToolChoice(body: Json): void {
  if (!("tool_choice" in body)) return;
  const choice = body.tool_choice;
  const suppress = () => {
    delete body.tool_choice;
    delete body.tools;
    delete body.functions;
  };
  if (typeof choice === "string") {
    if (choice.trim().toLowerCase() === "none") suppress();
    return;
  }
  if (!choice || typeof choice !== "object") {
    delete body.tool_choice;
    return;
  }
  const obj = choice as Json;
  const type = typeof obj.type === "string" ? obj.type.trim().toLowerCase() : "";
  if (type === "none") {
    suppress();
    return;
  }
  if (type === "auto" || type === "required") {
    body.tool_choice = type;
    return;
  }
  if (type === "function") {
    const fn = (obj.function as Json | undefined) ?? undefined;
    let name = typeof fn?.name === "string" ? fn.name : "";
    if (!name && typeof obj.name === "string") name = obj.name;
    body.tool_choice = name.trim() || "auto";
    return;
  }
  delete body.tool_choice;
}

/** `\_` in schema patterns is rejected upstream (11129); it matches `_` everywhere. */
function unescapePatterns(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) unescapePatterns(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Json;
  if (typeof obj.pattern === "string" && obj.pattern.includes("\\_")) {
    obj.pattern = obj.pattern.split("\\_").join("_");
  }
  if (obj.patternProperties && typeof obj.patternProperties === "object") {
    const source = obj.patternProperties as Json;
    const rebuilt: Json = {};
    for (const [key, value] of Object.entries(source)) rebuilt[key.split("\\_").join("_")] = value;
    obj.patternProperties = rebuilt;
    unescapePatterns(source);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === "patternProperties") continue;
    unescapePatterns(value);
  }
}

function normalizeToolPatterns(body: Json): void {
  if (!Array.isArray(body.tools)) return;
  for (const raw of body.tools as unknown[]) {
    const tool = raw as Json;
    if (!tool || typeof tool !== "object") continue;
    const fn = tool.function as Json | undefined;
    if (fn && typeof fn === "object") unescapePatterns(fn.parameters);
    unescapePatterns(tool.parameters);
  }
}

/**
 * Upstream only emits native tool_calls when tool_choice is present; without it the
 * model answers with `<function_calls>` markup text that no client can execute.
 */
function defaultToolChoice(body: Json): void {
  if (!Array.isArray(body.tools) || (body.tools as unknown[]).length === 0) return;
  if ("tool_choice" in body) return;
  body.tool_choice = "auto";
}

/** `developer` is not on upstream's role whitelist (400 code 11-128). */
function normalizeRoles(body: Json): void {
  if (!Array.isArray(body.messages)) return;
  for (const raw of body.messages as unknown[]) {
    const msg = raw as Json;
    if (!msg || typeof msg !== "object") continue;
    if (typeof msg.role === "string" && msg.role.trim().toLowerCase() === "developer") msg.role = "system";
  }
}

/** Upstream only accepts the object form of image_url. */
function normalizeImageUrl(body: Json): void {
  if (!Array.isArray(body.messages)) return;
  for (const raw of body.messages as unknown[]) {
    const msg = raw as Json;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const rawPart of msg.content as unknown[]) {
      const part = rawPart as Json;
      if (!part || part.type !== "image_url") continue;
      if (typeof part.image_url === "string" && part.image_url) part.image_url = { url: part.image_url };
    }
  }
}

/** Content whitelist excludes reasoning parts (11101 unsupported content type). */
function dropReasoningContentParts(body: Json): void {
  if (!Array.isArray(body.messages)) return;
  const out: unknown[] = [];
  for (const raw of body.messages as unknown[]) {
    const msg = raw as Json;
    if (!msg || typeof msg !== "object" || !Array.isArray(msg.content)) {
      out.push(raw);
      continue;
    }
    const kept = (msg.content as unknown[]).filter((rawPart) => {
      const part = rawPart as Json;
      if (!part || typeof part !== "object") return true;
      const type = typeof part.type === "string" ? part.type.trim() : "";
      return type !== "reasoning_text" && type !== "reasoning";
    });
    if (kept.length === 0 && !("tool_calls" in msg)) continue;
    msg.content = kept;
    out.push(raw);
  }
  body.messages = out;
}

function ensureDeepSeekEffort(body: Json, defaultEffort: string): void {
  if ("reasoning_effort" in body || "reasoningEffort" in body) return;
  body.reasoning_effort = defaultEffort || DEFAULT_DEEPSEEK_EFFORT;
}

/**
 * DeepSeek needs thinking.type=enabled *and* an effort level, otherwise upstream
 * answers without reasoning content.
 */
function injectThinking(body: Json, defaultEffort: string): void {
  const model = typeof body.model === "string" ? body.model : "";
  if (!isDeepSeek(model)) return;
  const thinking = body.thinking && typeof body.thinking === "object" ? (body.thinking as Json) : undefined;
  const type = typeof thinking?.type === "string" ? thinking.type.trim() : "";
  if (type) {
    if (type.toLowerCase() === "disabled") {
      delete body.reasoning_effort;
      delete body.reasoningEffort;
      return;
    }
    ensureDeepSeekEffort(body, defaultEffort);
    return;
  }
  if (thinking) thinking.type = "enabled";
  else body.thinking = { type: "enabled" };
  ensureDeepSeekEffort(body, defaultEffort);
}

/** Global WorkBuddy advertises extra DeepSeek levels that its upstream does not serve reliably. */
function supportedEffortsForRealm(model: string, efforts: Record<string, string[]> | undefined, realm?: Realm): string[] | undefined {
  const canonical = model.replace(/^(?:global|cn):/i, "").toLowerCase();
  if (realm === "global" && canonical === "deepseek-v4.1-flash") return ["high"];
  return efforts?.[model];
}

/** Clamp reasoning_effort to what the model actually supports. */
export function normalizeReasoningEffort(body: Json, efforts?: Record<string, string[]>, realm?: Realm): void {
  const model = typeof body.model === "string" ? body.model : "";
  if (!model) return;
  const supported = supportedEffortsForRealm(model, efforts, realm);
  if (!supported || supported.length === 0) return;
  const key = "reasoning_effort" in body ? "reasoning_effort" : "reasoningEffort" in body ? "reasoningEffort" : "";
  if (!key) return;
  const requested = body[key];
  if (typeof requested !== "string") return;
  const requestedRank = EFFORT_RANK[requested.trim().toLowerCase()];
  if (requestedRank === undefined) return;
  let best = "";
  let bestRank = -1;
  for (const candidate of supported) {
    const rank = EFFORT_RANK[candidate.trim().toLowerCase()];
    if (rank !== undefined && rank <= requestedRank && rank > bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  if (best) {
    if (best.toLowerCase() !== requested.trim().toLowerCase()) body[key] = best;
    return;
  }
  let lowest = "";
  let lowestRank = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const rank = EFFORT_RANK[candidate.trim().toLowerCase()];
    if (rank !== undefined && rank < lowestRank) {
      lowest = candidate;
      lowestRank = rank;
    }
  }
  if (lowest) body[key] = lowest;
}

/** DeepSeek multi-turn consistency: assistant messages must carry reasoning text. */
function backfillReasoningContent(body: Json): void {
  if (!Array.isArray(body.messages)) return;
  const messages = body.messages as unknown[];
  const thinking = body.thinking as Json | undefined;
  const thinkingEnabled = !!thinking && typeof thinking.type === "string" && thinking.type.toLowerCase() === "enabled";
  let hasTrace = false;
  for (const raw of messages) {
    const msg = raw as Json;
    if (!msg || msg.role !== "assistant") continue;
    if ((typeof msg.reasoning === "string" && msg.reasoning !== "") || "reasoning_content" in msg) {
      hasTrace = true;
      break;
    }
  }
  if (!thinkingEnabled && !hasTrace) return;
  for (const raw of messages) {
    const msg = raw as Json;
    if (!msg || msg.role !== "assistant") continue;
    let rc = typeof msg.reasoning_content === "string" ? msg.reasoning_content : undefined;
    if (rc === undefined) {
      rc = typeof msg.reasoning === "string" ? msg.reasoning : "";
      msg.reasoning_content = rc;
    }
    const reasoning = typeof msg.reasoning === "string" ? msg.reasoning : "";
    if (reasoning !== "") continue;
    // Upstream validates len(reasoning) > 0 without trimming: a single space passes.
    msg.reasoning = rc !== "" ? rc : " ";
  }
}

/** Upstream prefix cache: same key = cache hit, ~17x cheaper. Must be account-isolated. */
function injectPromptCacheKey(body: Json, uid: string, conversationId?: string): void {
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key) return;
  const fromBody = typeof body.conversation_id === "string" ? body.conversation_id
    : typeof body.conversationId === "string" ? body.conversationId : "";
  const source = fromBody || conversationId || "";
  const conv = source ? createHash("sha256").update(source).digest("hex").slice(0, 16) : "nocache";
  body.prompt_cache_key = `wb2p-${uid.slice(0, 8)}-${conv}`;
}

function ensureSystemFirst(body: Json): void {
  if (!Array.isArray(body.messages) || (body.messages as unknown[]).length === 0) return;
  const first = (body.messages as unknown[])[0] as Json;
  if (first && typeof first.role === "string" && first.role.trim().toLowerCase() === "system") return;
  body.messages = [{ role: "system", content: "You are a helpful assistant." }, ...(body.messages as unknown[])];
}

/** Full outbound pipeline. Unknown/malformed bodies are returned untouched. */
export function prepareBody(input: unknown, options: PrepareOptions): unknown {
  if (!input || typeof input !== "object") return input;
  const body = structuredClone(input) as Json;

  body.stream = true;
  translateMaxCompletionTokens(body);
  clampGptMinMaxTokens(body);
  if (!("stream_options" in body)) body.stream_options = { include_usage: true };
  normalizeToolChoice(body);
  defaultToolChoice(body);
  normalizeToolPatterns(body);
  normalizeRoles(body);
  normalizeImageUrl(body);
  dropReasoningContentParts(body);

  if (Array.isArray(body.messages)) {
    const messages = body.messages as unknown[];
    const merged = mergeAdjacentToolCalls(messages);
    const repacked = repackToolResultBlocks(merged.messages);
    const cleaned = cleanupOrphanToolCalls(repacked.messages);
    body.messages = cleaned.messages;
  }

  const model = typeof body.model === "string" ? body.model : options.model;
  if (model && body.model !== model) body.model = model;
  injectThinking(body, options.defaultEfforts?.[model] ?? "");
  normalizeReasoningEffort(body, options.efforts, options.realm);
  backfillReasoningContent(body);
  if (options.ensureSystem) ensureSystemFirst(body);
  injectPromptCacheKey(body, options.uid, options.conversationId);
  return body;
}
