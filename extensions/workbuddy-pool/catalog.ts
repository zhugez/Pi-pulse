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

/** Fetch the CLI model catalog: per-model limits plus the effort levels upstream accepts. */
export async function fetchCatalog(account: WbAccount, signal?: AbortSignal, fetchImpl = wbFetch()): Promise<WbCatalog> {
  const response = await fetchImpl(`${accountBase(account)}/v2/enterprises/personal/models`, {
    headers: chatHeaders(account, newChatMeta()),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`WorkBuddy model catalog failed: HTTP ${response.status} ${text.slice(0, 160)}`);
  const parsed = JSON.parse(text) as { code?: unknown; msg?: string; data?: { models?: RawModel[] } };
  const raw = parsed.data?.models ?? [];
  const models: WbModelInfo[] = [];
  const efforts: Record<string, string[]> = {};
  const defaultEfforts: Record<string, string> = {};
  for (const item of raw) {
    if (!item.id) continue;
    const supported = (item.reasoning?.supportedEfforts ?? []).map((value) => value.toLowerCase());
    const defaultEffort = item.reasoning?.defaultEffort?.toLowerCase();
    models.push({
      id: item.id,
      name: item.name || item.id,
      description: item.descriptionEn || item.descriptionZh,
      contextWindow: item.maxInputTokens ?? item.maxAllowedSize ?? 200_000,
      maxTokens: item.maxOutputTokens ?? 32_000,
      supportsImages: item.supportsImages !== false,
      supportsTools: item.supportsToolCall !== false,
      reasoning: supported.length > 0 || !!item.reasoning,
      supportedEfforts: supported,
      defaultEffort,
      credits: item.credits,
    });
    if (supported.length > 0) efforts[item.id] = supported;
    if (defaultEffort) defaultEfforts[item.id] = defaultEffort;
  }
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
