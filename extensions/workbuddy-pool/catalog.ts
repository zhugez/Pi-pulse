import { wbFetch } from "./nodefetch.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { chatHeaders, newChatMeta } from "./headers.ts";
import { accountBase, type WbAccount } from "./store.ts";

export const PROVIDER_ID = "workbuddy";
export const PROVIDER_NAME = "WorkBuddy";

export interface WbModelInfo {
  id: string;
  name: string;
  description?: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  supportsTools: boolean;
  reasoning: boolean;
  supportedEfforts: string[];
  defaultEffort?: string;
  credits?: string;
}

export interface WbCatalog {
  models: WbModelInfo[];
  efforts: Record<string, string[]>;
  defaultEfforts: Record<string, string>;
}

interface RawModel {
  id?: string;
  name?: string;
  descriptionEn?: string;
  descriptionZh?: string;
  maxAllowedSize?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsToolCall?: boolean;
  credits?: string;
  tags?: string[];
  reasoning?: { supportedEfforts?: string[]; defaultEffort?: string; effort?: string; canDisableThinking?: boolean };
}

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function thinkingLevelMap(supported: string[]): ThinkingLevelMap | undefined {
  if (supported.length === 0) return undefined;
  const map: Record<string, string | null> = {};
  const set = new Set(supported.map((value) => value.toLowerCase()));
  for (const level of PI_THINKING_LEVELS) {
    map[level] = set.has(level) ? level : null;
  }
  return map as ThinkingLevelMap;
}

/** UA for /v3/config. The endpoint is UA-sensitive: without a CodeBuddy version it 400s (code 12403), and the CLI UA returns the widest chat set (deepseek series, grok, gemini-3.8, gpt-6.*). */
const V3_CLI_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

/** Skip non-chat entries: hidden prefixes, tiny output windows, image/video models (same rules as the panel's nonChatModel). */
function nonChatModel(id: string, maxOutputTokens?: number, tags?: string[]): boolean {
  const lower = id.toLowerCase();
  if (lower.startsWith("nes-") || lower.startsWith("completion-") || lower.startsWith("codewise-")) return true;
  if (maxOutputTokens !== undefined && maxOutputTokens > 0 && maxOutputTokens <= 256) return true;
  return (tags ?? []).some((tag) => ["text-to-image", "image-to-image", "text-to-video", "image-to-video"].includes(tag));
}

function rawToModelInfo(item: RawModel): WbModelInfo {
  const supported = (item.reasoning?.supportedEfforts ?? []).map((value) => value.toLowerCase());
  const defaultEffort = (item.reasoning?.defaultEffort ?? item.reasoning?.effort)?.toLowerCase();
  return {
    id: item.id!,
    name: item.name || item.id!,
    description: item.descriptionEn || item.descriptionZh,
    contextWindow: item.maxInputTokens ?? item.maxAllowedSize ?? 200_000,
    maxTokens: item.maxOutputTokens ?? 32_000,
    supportsImages: item.supportsImages !== false,
    supportsTools: item.supportsToolCall !== false,
    reasoning: supported.length > 0 || !!item.reasoning,
    supportedEfforts: supported,
    defaultEffort,
    credits: item.credits,
  };
}

/** Fetch the /v3/config catalog (CLI UA). Model sets differ per UA — the panel probes three UAs; the CLI UA covers everything the desktop one returns plus the deepseek series. (IDE-only models like o4-mini/auto-chat are skipped.) */
async function fetchV3Config(account: WbAccount, signal: AbortSignal | undefined, fetchImpl: ReturnType<typeof wbFetch>): Promise<RawModel[]> {
  const response = await fetchImpl(`${accountBase(account)}/v3/config`, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      Authorization: `Bearer ${account.accessToken}`,
      "X-User-Id": account.uid,
      "X-Domain": account.domain || new URL(accountBase(account)).host,
      "X-Product": "SaaS",
      "User-Agent": V3_CLI_UA,
      "X-CodeBuddy-Request": "1",
    },
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`WorkBuddy v3 config failed: HTTP ${response.status} ${text.slice(0, 160)}`);
  const parsed = JSON.parse(text) as { code?: unknown; msg?: string; data?: { models?: RawModel[] } };
  return (parsed.data?.models ?? []).filter((item) => item.id && !nonChatModel(item.id, item.maxOutputTokens, item.tags));
}

/** Fetch the CLI model catalog: per-model limits plus the effort levels upstream accepts.
 *
 * Two sources merged (union, /v2 authoritative per-model): the enterprise /v2 list and
 * /v3/config with the CLI UA — the latter carries deepseek/grok/gemini-3.8/gpt-6.* entries
 * that /v2 never returns. One source failing degrades to the other; only both failing throws. */
export async function fetchCatalog(account: WbAccount, signal?: AbortSignal, fetchImpl = wbFetch()): Promise<WbCatalog> {
  const models: WbModelInfo[] = [];
  const efforts: Record<string, string[]> = {};
  const defaultEfforts: Record<string, string> = {};
  const add = (item: RawModel) => {
    if (!item.id) return;
    const info = rawToModelInfo(item);
    models.push(info);
    if (info.supportedEfforts.length > 0) efforts[info.id] = info.supportedEfforts;
    if (info.defaultEffort) defaultEfforts[info.id] = info.defaultEffort;
  };

  let v2Error: unknown;
  let v3Error: unknown;
  try {
    const response = await fetchImpl(`${accountBase(account)}/v2/enterprises/personal/models`, {
      headers: chatHeaders(account, newChatMeta()),
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 160)}`);
    const parsed = JSON.parse(text) as { data?: { models?: RawModel[] } };
    for (const item of parsed.data?.models ?? []) add(item);
  } catch (error) {
    v2Error = error; // /v3 result still usable below
  }
  const v2Count = models.length;
  try {
    const v3Models = await fetchV3Config(account, signal, fetchImpl);
    const known = new Set(models.map((model) => model.id));
    for (const item of v3Models) {
      if (known.has(item.id!)) continue;
      add(item);
    }
  } catch (error) {
    v3Error = error; // /v2 result still usable; deepseek & friends just stay hidden
  }
  if (v2Count === 0 && v3Error) {
    throw new Error(`WorkBuddy model catalog failed (v2: ${v2Error instanceof Error ? v2Error.message : "failed"}; v3: ${v3Error instanceof Error ? v3Error.message : "failed"})`);
  }
  if (models.length === 0) throw new Error("WorkBuddy model catalog empty");
  return { models, efforts, defaultEfforts };
}

export function toPiModels(catalog: WbCatalog, baseUrl: string): Model<"openai-completions">[] {
  return catalog.models.map((model) => ({
    id: model.id,
    name: `${PROVIDER_NAME} · ${model.name}`,
    api: "openai-completions" as const,
    provider: PROVIDER_ID,
    baseUrl,
    input: model.supportsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    thinkingLevelMap: thinkingLevelMap(model.supportedEfforts),
    compat: {
      maxTokensField: "max_tokens" as const,
      supportsUsageInStreaming: true,
      supportsReasoningEffort: model.supportedEfforts.length > 0,
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsStrictMode: false,
      requiresReasoningContentOnAssistantMessages: model.id.toLowerCase().includes("deepseek"),
    },
  }));
}

/**
 * pi asks `getModels()` synchronously at startup, before any network call, so the
 * provider needs a catalog in hand from the first tick: disk cache first, then a
 * static snapshot of the models the CLI agent advertises.
 */
const CACHE_FILE = () => join(getAgentDir(), "workbuddy-models.json");

export function loadCachedCatalog(): WbCatalog | undefined {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE(), "utf8")) as WbCatalog;
    return Array.isArray(parsed.models) && parsed.models.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveCatalog(catalog: WbCatalog): void {
  try {
    writeFileSync(CACHE_FILE(), JSON.stringify(catalog, null, 2), { mode: 0o600 });
  } catch {
    /* cache is best-effort */
  }
}

function staticModel(id: string, name: string, contextWindow: number, maxTokens: number, efforts: string[] = [], supportsImages = true): WbModelInfo {
  return { id, name, contextWindow, maxTokens, supportsImages, supportsTools: true, reasoning: efforts.length > 0, supportedEfforts: efforts };
}

/** Snapshot of the upstream CLI catalog, used only before the first successful fetch. */
export const STATIC_CATALOG: WbCatalog = (() => {
  const models = [
    staticModel("default-model", "Auto", 176_000, 24_000),
    staticModel("fast-model", "Fast", 176_000, 24_000),
    staticModel("balanced-model", "Balanced", 176_000, 24_000),
    staticModel("primary-model", "Primary", 176_000, 24_000),
    staticModel("deep-model", "Deep", 176_000, 24_000),
    staticModel("hy4-preview", "Hy4 preview", 176_000, 32_000, ["high"]),
    staticModel("hy3", "Hy3", 176_000, 32_000, ["low", "high"]),
    staticModel("gpt-5.6-sol", "GPT-5.6-Sol", 272_000, 128_000, ["low", "medium", "high", "xhigh", "max"]),
    staticModel("gpt-5.6-terra", "GPT-5.6-Terra", 272_000, 128_000, ["low", "medium", "high", "xhigh", "max"]),
    staticModel("gpt-5.6-luna", "GPT-5.6-Luna", 272_000, 128_000, ["low", "medium", "high", "xhigh", "max"]),
    staticModel("gpt-5.5", "GPT-5.5", 272_000, 72_000, ["low", "medium", "high", "xhigh"]),
    staticModel("gpt-5.4", "GPT-5.4", 272_000, 72_000, ["low", "medium", "high", "xhigh"]),
    staticModel("gpt-5.3-codex", "GPT-5.3-Codex", 272_000, 128_000),
    staticModel("gemini-3.5-flash", "Gemini-3.5-Flash", 1_000_000, 64_000),
    staticModel("glm-5.3", "GLM-5.3", 1_000_000, 64_000, ["low", "high", "max"]),
    staticModel("glm-5.2", "GLM-5.2", 1_000_000, 48_000, ["high", "xhigh"]),
    staticModel("kimi-k3", "Kimi-K3", 256_000, 32_000),
    staticModel("kimi-k2.6", "Kimi-K2.6", 256_000, 32_000),
  ];
  const efforts: Record<string, string[]> = {};
  for (const model of models) if (model.supportedEfforts.length > 0) efforts[model.id] = model.supportedEfforts;
  return { models, efforts, defaultEfforts: {} };
})();
