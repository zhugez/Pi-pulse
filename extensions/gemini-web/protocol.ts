// Adapted from gemini-web-to-api (https://github.com/ntthanh2603/gemini-web-to-api)
// Pinned upstream commit: 1f1577dbd479d5b61a1c5f03de742ffcdeb51f6d
// Copyright (c) 2025 Nguyễn Tuấn Thành
// Licensed under the MIT License.
//
// Capacity flag precedence adapted from Gemini-API (https://github.com/HanaokaYuzu/Gemini-API)
// Copyright (c) 2024 HanaokaYuzu
// Licensed under the MIT License.

import type { Context, Message, Tool, ToolCall } from '@earendil-works/pi-ai';
import { validateToolCall } from '@earendil-works/pi-ai';

export const PROVIDER_ID = 'gemini-web';
export const GEMINI_WEB_API = 'gemini-web';

export type WebModel = Readonly<{
  id: string;
  name: string;
  capacity: number;
  capacityField: 12 | 13;
  modelNumber: number;
}>;

export function getFriendlyModelName(model: WebModel): string {
  const rawName = model.name?.trim() || '';
  if (!rawName || !/[a-z0-9]/i.test(rawName)) {
    return `Gemini ${model.id}`;
  }
  if (/^gemini\b/i.test(rawName)) {
    return 'Gemini' + rawName.slice(6);
  }
  return `Gemini ${rawName}`;
}

export function deriveBaseModelSlug(name: string, rawId: string): string {
  const trimmed = name?.trim() || '';
  let withoutPrefix = trimmed;
  if (/^gemini\b/i.test(withoutPrefix)) {
    withoutPrefix = withoutPrefix.slice(6).trim();
  }
  const slugPart = withoutPrefix
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slugPart || slugPart === 'gemini') {
    const rawClean = rawId
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `gemini-${rawClean || 'unknown'}`;
  }
  return `gemini-${slugPart}`;
}

export function getFriendlyModelId(
  model: WebModel,
  catalog: readonly WebModel[] = [model],
): string {
  const baseSlug = deriveBaseModelSlug(model.name, model.id);
  const collisions = catalog.filter(
    (m) => deriveBaseModelSlug(m.name, m.id) === baseSlug,
  );
  if (collisions.length <= 1) {
    return baseSlug;
  }
  const rawClean = model.id
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = rawClean || 'dup';
  return `${baseSlug}-${suffix}`;
}

export type WebThinkingLevel = 'low' | 'medium' | 'high';

export function validateWebThinkingLevel(
  level?: unknown,
): WebThinkingLevel {
  if (level === undefined) {
    return 'low';
  }
  if (level === 'low' || level === 'medium' || level === 'high') {
    return level;
  }
  throw new GeminiWebError('unsupported');
}

export function parseWebThinkingLevel(
  level?: unknown,
): number {
  const normalized =
    level === '' ? undefined : typeof level === 'string' ? level.trim().toLowerCase() : level;
  const validated = validateWebThinkingLevel(normalized);
  switch (validated) {
    case 'low':
      return 1;
    case 'medium':
      return 4;
    case 'high':
      return 2;
  }
}

export type WebBootstrap = Readonly<{
  at: string;
  buildLabel: string;
  sessionId: string;
  language: string;
}>;

export type WebSession = WebBootstrap & Readonly<{
  authUser: number;
  generationId: string;
}>;

export type WebWireRequest = Readonly<{
  url: string;
  method: 'POST';
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

export type WebPayload = Readonly<{ prompt: string }>;

export type PreparedPrompt = Readonly<{
  payload: WebPayload;
  tools: Tool[];
}>;

export type WebGeneration = Readonly<{ text: string; thinking?: string }>;

export type DecodedReply = Readonly<{
  text: string;
  toolCalls: ToolCall[];
}>;

export type WebErrorCode =
  | 'credentials'
  | 'auth'
  | 'network'
  | 'http'
  | 'protocol'
  | 'model'
  | 'tools'
  | 'unsupported'
  | 'storage'
  | 'closed';

function defaultErrorMessage(code: WebErrorCode, status?: number): string {
  switch (code) {
    case 'credentials':
      return 'Gemini Web credentials are missing or invalid.';
    case 'auth':
      return 'Gemini Web authentication failed. Check credentials or session.';
    case 'network':
      return 'Gemini Web network request failed.';
    case 'http':
      return typeof status === 'number'
        ? `Gemini Web request failed with HTTP status ${status}.`
        : 'Gemini Web HTTP request failed.';
    case 'protocol':
      return 'Gemini Web protocol error: unexpected response format.';
    case 'model':
      return 'Gemini Web model is unavailable or invalid.';
    case 'tools':
      return 'Gemini Web tool call error: invalid tool call format or schema validation failed.';
    case 'unsupported':
      return 'Gemini Web unsupported feature or content type.';
    case 'storage':
      return 'Gemini Web credential storage error.';
    case 'closed':
      return 'Gemini Web client is closed.';
  }
}

export class GeminiWebError extends Error {
  readonly code: WebErrorCode;
  readonly status?: number;

  constructor(code: WebErrorCode, status?: number) {
    super(defaultErrorMessage(code, status));
    this.name = 'GeminiWebError';
    this.code = code;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function safeWebError(error: unknown): string {
  if (error instanceof GeminiWebError) {
    return error.message;
  }
  if (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.message.toLowerCase().includes('aborted') ||
      error.message.toLowerCase().includes('abort'))
  ) {
    return 'Operation was aborted.';
  }
  return 'Gemini Web operation failed.';
}

const accessTokenRegex = /"SNlM0e":"([^"\\]*(?:\\.[^"\\]*)*)"/;
const accessTokenFallbackRegex = /\["SNlM0e","([^"\\]*(?:\\.[^"\\]*)*)"\]/;
const escapedAccessTokenRegex = /\\"SNlM0e\\":\\"([^"\\]*(?:\\.[^"\\]*)*)\\"/;
const escapedAccessTokenFallbackRegex = /\[\\"SNlM0e\\",\\"([^"\\]*(?:\\.[^"\\]*)*)\\"\]/;

const buildLabelRegex = /"cfb2h":"([^"\\]*(?:\\.[^"\\]*)*)"/;
const escapedBuildLabelRegex = /\\"cfb2h\\":\\"([^"\\]*(?:\\.[^"\\]*)*)\\"/;

const sessionIDRegex = /"FdrFJe":"([^"\\]*(?:\\.[^"\\]*)*)"/;
const escapedSessionIDRegex = /\\"FdrFJe\\":\\"([^"\\]*(?:\\.[^"\\]*)*)\\"/;

const languageRegex = /"TuX5cc":"([^"\\]*(?:\\.[^"\\]*)*)"/;
const escapedLanguageRegex = /\\"TuX5cc\\":\\"([^"\\]*(?:\\.[^"\\]*)*)\\"/;

function unescapeJsonString(str: string): string {
  try {
    return JSON.parse(`"${str}"`);
  } catch {
    return str
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
  }
}

export function parseBootstrap(html: string): WebBootstrap {
  let atMatch = accessTokenRegex.exec(html);
  if (!atMatch) atMatch = accessTokenFallbackRegex.exec(html);
  if (!atMatch) atMatch = escapedAccessTokenRegex.exec(html);
  if (!atMatch) atMatch = escapedAccessTokenFallbackRegex.exec(html);

  if (!atMatch || !atMatch[1]) {
    throw new GeminiWebError('auth');
  }

  const at = unescapeJsonString(atMatch[1]).trim();
  if (!at) {
    throw new GeminiWebError('auth');
  }

  let buildLabelMatch = buildLabelRegex.exec(html);
  if (!buildLabelMatch) buildLabelMatch = escapedBuildLabelRegex.exec(html);
  const buildLabel = buildLabelMatch && buildLabelMatch[1] ? unescapeJsonString(buildLabelMatch[1]).trim() : '';

  let sessionIDMatch = sessionIDRegex.exec(html);
  if (!sessionIDMatch) sessionIDMatch = escapedSessionIDRegex.exec(html);
  const sessionId = sessionIDMatch && sessionIDMatch[1] ? unescapeJsonString(sessionIDMatch[1]).trim() : '';

  let languageMatch = languageRegex.exec(html);
  if (!languageMatch) languageMatch = escapedLanguageRegex.exec(html);
  const language = languageMatch && languageMatch[1] ? unescapeJsonString(languageMatch[1]).trim() : 'en';

  return {
    at,
    buildLabel,
    sessionId,
    language: language || 'en',
  };
}

const MAX_FRAMES = 1000;
const MAX_JSON_DEPTH = 32;

function checkDepth(value: unknown, currentDepth = 0): void {
  if (currentDepth > MAX_JSON_DEPTH) {
    throw new GeminiWebError('protocol');
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) {
        checkDepth(item, currentDepth + 1);
      }
    } else {
      for (const item of Object.values(value as Record<string, unknown>)) {
        checkDepth(item, currentDepth + 1);
      }
    }
  }
}

function findBalancedJsonRoot(text: string, startPos: number): number {
  const openChar = text[startPos];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startPos; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === openChar) {
      depth++;
      if (depth > MAX_JSON_DEPTH) {
        throw new GeminiWebError('protocol');
      }
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
      if (depth < 0) {
        throw new GeminiWebError('protocol');
      }
    }
  }

  throw new GeminiWebError('protocol');
}

export function decodeWebFrames(body: string): unknown[] {
  let cleaned = body.trimStart();
  if (cleaned.startsWith(")]}'")) {
    cleaned = cleaned.slice(4).trimStart();
  }

  if (cleaned.length === 0) {
    return [];
  }

  const frames: unknown[] = [];
  let pos = 0;
  const utf8Buffer = Buffer.from(cleaned, 'utf8');
  let byteOffset = 0;

  while (pos < cleaned.length) {
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) {
      pos++;
    }
    if (pos >= cleaned.length) break;

    const remainingStr = cleaned.slice(pos);
    const numLineMatch = /^(\d+)\r?\n/.exec(remainingStr);

    if (numLineMatch) {
      const declaredLength = Number.parseInt(numLineMatch[1], 10);
      if (Number.isNaN(declaredLength) || declaredLength < 0) {
        throw new GeminiWebError('protocol');
      }

      const numLineCharLen = numLineMatch[0].length;
      const contentCharStart = pos + numLineCharLen;
      const numLineByteLen = Buffer.byteLength(numLineMatch[0], 'utf8');
      const contentByteStart = byteOffset + numLineByteLen;

      let parsed = false;

      // Try UTF-8 byte length slice first
      if (declaredLength > 0 && contentByteStart + declaredLength <= utf8Buffer.length) {
        try {
          const chunkBuf = utf8Buffer.subarray(contentByteStart, contentByteStart + declaredLength);
          const chunkStr = chunkBuf.toString('utf8');
          const trimmedChunk = chunkStr.trim();
          if (trimmedChunk.startsWith('{') || trimmedChunk.startsWith('[')) {
            const val = JSON.parse(trimmedChunk);
            checkDepth(val);
            frames.push(val);
            if (frames.length > MAX_FRAMES) throw new GeminiWebError('protocol');
            byteOffset = contentByteStart + declaredLength;
            pos = contentCharStart + chunkStr.length;
            parsed = true;
          }
        } catch (err) {
          if (err instanceof GeminiWebError) throw err;
          parsed = false;
        }
      }

      // If byte slicing didn't yield a valid JSON frame, try character length slice
      if (!parsed && declaredLength > 0 && contentCharStart + declaredLength <= cleaned.length) {
        try {
          const chunkStr = cleaned.slice(contentCharStart, contentCharStart + declaredLength);
          const trimmedChunk = chunkStr.trim();
          if (trimmedChunk.startsWith('{') || trimmedChunk.startsWith('[')) {
            const val = JSON.parse(trimmedChunk);
            checkDepth(val);
            frames.push(val);
            if (frames.length > MAX_FRAMES) throw new GeminiWebError('protocol');
            pos = contentCharStart + declaredLength;
            byteOffset = Buffer.byteLength(cleaned.slice(0, pos), 'utf8');
            parsed = true;
          }
        } catch (err) {
          if (err instanceof GeminiWebError) throw err;
          parsed = false;
        }
      }

      // If declared length didn't match, check if number was dummy framing before a JSON root
      if (!parsed) {
        if (contentCharStart < cleaned.length && (cleaned[contentCharStart] === '{' || cleaned[contentCharStart] === '[')) {
          const endPos = findBalancedJsonRoot(cleaned, contentCharStart);
          const jsonText = cleaned.slice(contentCharStart, endPos);
          try {
            const val = JSON.parse(jsonText);
            checkDepth(val);
            frames.push(val);
            if (frames.length > MAX_FRAMES) throw new GeminiWebError('protocol');
            pos = endPos;
            byteOffset = Buffer.byteLength(cleaned.slice(0, pos), 'utf8');
            parsed = true;
          } catch {
            throw new GeminiWebError('protocol');
          }
        } else {
          throw new GeminiWebError('protocol');
        }
      }
    } else if (cleaned[pos] === '{' || cleaned[pos] === '[') {
      const endPos = findBalancedJsonRoot(cleaned, pos);
      const jsonText = cleaned.slice(pos, endPos);
      try {
        const val = JSON.parse(jsonText);
        checkDepth(val);
        frames.push(val);
        if (frames.length > MAX_FRAMES) throw new GeminiWebError('protocol');
        pos = endPos;
        byteOffset = Buffer.byteLength(cleaned.slice(0, pos), 'utf8');
      } catch {
        throw new GeminiWebError('protocol');
      }
    } else {
      throw new GeminiWebError('protocol');
    }
  }

  return frames;
}

function collectModelRecords(value: unknown, records: unknown[][], depth = 0): void {
  if (depth > 16 || !Array.isArray(value)) return;
  if (value.length >= 2) {
    const marker = value[0];
    const rpcId = value[1];
    if ((marker === 'wrb.fr' || marker === 'er') && rpcId === 'otAQ7b') {
      records.push(value);
      return;
    }
  }
  for (const item of value) {
    collectModelRecords(item, records, depth + 1);
  }
}

function computeCapacity(tierVal: unknown, capVal: unknown): { capacity: number; capacityField: 12 | 13 } {
  const tiers = Array.isArray(tierVal) ? tierVal : [];
  const caps = Array.isArray(capVal) ? capVal : [];

  const has = (flags: unknown[], want: number): boolean => {
    return flags.some((f) => {
      const n = typeof f === 'number' ? f : Number(f);
      return Number.isInteger(n) && n === want;
    });
  };

  if (has(tiers, 21)) {
    return { capacity: 1, capacityField: 13 };
  }
  if (has(tiers, 22)) {
    return { capacity: 2, capacityField: 13 };
  }
  if (has(caps, 115)) {
    return { capacity: 4, capacityField: 12 };
  }
  if (has(tiers, 16) || has(caps, 106)) {
    return { capacity: 3, capacityField: 12 };
  }
  if (has(tiers, 8) || has(caps, 19)) {
    return { capacity: 2, capacityField: 12 };
  }
  return { capacity: 1, capacityField: 12 };
}

function sanitizeDisplayName(raw: string): string {
  // Remove control characters (0x00-0x1F, 0x7F)
  return raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

export function parseModelCatalog(frames: readonly unknown[]): WebModel[] {
  const records: unknown[][] = [];
  collectModelRecords(frames, records);

  if (records.length === 0) {
    throw new GeminiWebError('model');
  }

  const models: WebModel[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    const reject = Array.isArray(record[5]) ? record[5] : undefined;
    if (reject && typeof reject[0] === 'number' && reject[0] !== 0) {
      throw new GeminiWebError('auth');
    }

    let status: unknown[];
    const rawStatusVal = record[2];
    if (typeof rawStatusVal === 'string') {
      try {
        status = JSON.parse(rawStatusVal);
      } catch {
        throw new GeminiWebError('protocol');
      }
    } else if (Array.isArray(rawStatusVal)) {
      status = rawStatusVal;
    } else {
      throw new GeminiWebError('protocol');
    }

    if (!Array.isArray(status)) {
      throw new GeminiWebError('protocol');
    }

    const rawStatus = status[14];
    if (rawStatus !== undefined && rawStatus !== null) {
      const code = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus);
      if (!Number.isInteger(code) || code !== 1000) {
        throw new GeminiWebError('auth');
      }
    }

    const { capacity, capacityField } = computeCapacity(status[16], status[17]);
    const entries = Array.isArray(status[15]) ? status[15] : [];

    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;

      const rawId = entry[0];
      if (typeof rawId !== 'string') continue;
      const modelId = rawId.trim();
      if (!modelId || seen.has(modelId)) continue;

      const rawDisplay =
        (typeof entry[11] === 'string' && entry[11]) ||
        (typeof entry[19] === 'string' && entry[19]) ||
        (typeof entry[1] === 'string' && entry[1]) ||
        modelId;
      const displayName = sanitizeDisplayName(rawDisplay) || modelId;

      const rawNumber = entry[17] ?? entry[9];
      let modelNumber = 1;
      if (rawNumber !== null && rawNumber !== undefined) {
        const num = typeof rawNumber === 'number' ? rawNumber : Number(rawNumber);
        if (!Number.isInteger(num) || num <= 0) {
          continue;
        }
        modelNumber = num;
      }

      seen.add(modelId);
      models.push({
        id: modelId,
        name: displayName,
        capacity,
        capacityField,
        modelNumber,
      });

      if (models.length >= 64) {
        break;
      }
    }
  }

  if (models.length === 0) {
    throw new GeminiWebError('model');
  }

  return models;
}

export function buildDiscoveryRequest(session: WebSession, requestNumber: number): WebWireRequest {
  if (typeof session.authUser !== 'number' || !Number.isSafeInteger(session.authUser) || session.authUser < 0) {
    throw new GeminiWebError('protocol');
  }
  if (typeof session.at !== 'string' || session.at.length === 0) {
    throw new GeminiWebError('auth');
  }

  const query = new URLSearchParams();
  query.set('_reqid', String(requestNumber));
  if (session.buildLabel) query.set('bl', session.buildLabel);
  if (session.sessionId) query.set('f.sid', session.sessionId);
  query.set('hl', session.language || 'en');
  query.set('rpcids', 'otAQ7b');
  query.set('rt', 'c');
  query.set('source-path', `/u/${session.authUser}/app`);

  const selectorHeader = new Array(17).fill(null);
  selectorHeader[0] = 1;
  selectorHeader[8] = [4, 5, 6, 8];
  selectorHeader[16] = session.generationId;

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    Origin: 'https://gemini.google.com',
    Referer: 'https://gemini.google.com/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-Same-Domain': '1',
    'x-goog-ext-73010989-jspb': '[0]',
    'x-goog-ext-525001261-jspb': JSON.stringify(selectorHeader),
  };

  const form = new URLSearchParams();
  form.set('at', session.at);
  form.set('f.req', '[[["otAQ7b","[]",null,"generic"]]]');

  const url = `https://gemini.google.com/u/${session.authUser}/_/BardChatUi/data/batchexecute?${query.toString()}`;

  return {
    url,
    method: 'POST',
    headers,
    body: form.toString(),
  };
}

export function buildGenerateRequest(
  session: WebSession,
  model: WebModel,
  payload: WebPayload,
  requestId: string,
  requestNumber: number,
  thinking: WebThinkingLevel = 'low',
): WebWireRequest {
  if (typeof session.authUser !== 'number' || !Number.isSafeInteger(session.authUser) || session.authUser < 0) {
    throw new GeminiWebError('protocol');
  }
  if (typeof session.at !== 'string' || session.at.length === 0) {
    throw new GeminiWebError('auth');
  }
  if (
    typeof model?.id !== 'string' ||
    !model.id ||
    typeof model.modelNumber !== 'number' ||
    model.modelNumber <= 0 ||
    typeof model.capacity !== 'number' ||
    model.capacity <= 0 ||
    (model.capacityField !== 12 && model.capacityField !== 13)
  ) {
    throw new GeminiWebError('model');
  }
  if (typeof requestId !== 'string' || !requestId) {
    throw new GeminiWebError('protocol');
  }
  if (typeof payload?.prompt !== 'string') {
    throw new GeminiWebError('protocol');
  }

  const query = new URLSearchParams();
  query.set('_reqid', String(requestNumber));
  query.set('at', session.at);
  if (session.buildLabel) query.set('bl', session.buildLabel);
  if (session.sessionId) query.set('f.sid', session.sessionId);
  query.set('hl', session.language || 'en');
  query.set('rt', 'c');

  const thinkingValue = parseWebThinkingLevel(thinking);

  const offset = model.capacityField - 12;
  const selectorHeader = new Array(17 + offset).fill(null);
  selectorHeader[0] = 1;
  selectorHeader[4] = model.id;
  selectorHeader[7] = 0;
  selectorHeader[8] = [4, 5, 6, 8];
  selectorHeader[model.capacityField - 1] = model.capacity;
  selectorHeader[14 + offset] = model.modelNumber;
  selectorHeader[15 + offset] = thinkingValue;
  selectorHeader[16 + offset] = session.generationId;

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    Origin: 'https://gemini.google.com',
    Referer: 'https://gemini.google.com/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-Same-Domain': '1',
    'x-goog-ext-73010989-jspb': '[0]',
    'x-goog-ext-73010990-jspb': '[0,0,0]',
    'x-goog-ext-525005358-jspb': JSON.stringify([requestId, 1]),
    'x-goog-ext-525001261-jspb': JSON.stringify(selectorHeader),
  };

  const defaultMetadata = ['', '', '', null, null, null, null, null, null, ''];
  const inner = new Array(81).fill(null);
  inner[0] = [payload.prompt];
  inner[1] = [session.language || 'en'];
  inner[2] = defaultMetadata;
  inner[6] = [1];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[45] = 1; // temporary chat flag
  inner[53] = 0;
  inner[59] = requestId;
  inner[61] = [];
  inner[68] = 1;
  inner[79] = model.modelNumber;
  inner[80] = thinkingValue;

  const outer = [null, JSON.stringify(inner)];
  const form = new URLSearchParams();
  form.set('at', session.at);
  form.set('f.req', JSON.stringify(outer));

  const url = `https://gemini.google.com/u/${session.authUser}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${query.toString()}`;

  return {
    url,
    method: 'POST',
    headers,
    body: form.toString(),
  };
}

function containsBardErrorTag(v: unknown, depth = 0): boolean {
  if (depth > 10 || v === null || v === undefined) return false;
  if (typeof v === 'string') {
    return (
      v.includes('type.googleapis.com/assistant.boq.bard.application.BardErrorInfo') ||
      v === 'BardErrorInfo'
    );
  }
  if (Array.isArray(v)) {
    for (const child of v) {
      if (containsBardErrorTag(child, depth + 1)) return true;
    }
  } else if (typeof v === 'object') {
    for (const val of Object.values(v as Record<string, unknown>)) {
      if (containsBardErrorTag(val, depth + 1)) return true;
    }
  }
  return false;
}

function extractStructuredBardError(item: unknown[]): boolean {
  if (item.length > 5 && item[5] !== null && item[5] !== undefined) {
    if (containsBardErrorTag(item[5])) return true;
  }
  for (let i = 0; i < item.length; i++) {
    if (i === 2) continue; // Skip item[2] which carries the response payload
    if (containsBardErrorTag(item[i])) return true;
  }
  return false;
}

export function extractThinkingAndText(
  raw: string,
): { text: string; thinking?: string } {
  let remaining = raw;
  const thinkingParts: string[] = [];
  let sawThoughtBlock = false;

  while (true) {
    const match = remaining.match(/^(\s*)<ctrl94>(thought)?/);
    if (!match) {
      break;
    }
    sawThoughtBlock = true;

    const startPos = match[0].length;
    const endIdx = remaining.indexOf('<ctrl95>', startPos);
    if (endIdx === -1) {
      // Malformed / unclosed leading thought marker -> fail safely with protocol error
      throw new GeminiWebError('protocol');
    }

    const thoughtContent = remaining.slice(startPos, endIdx).trim();
    if (thoughtContent.length > 0) {
      thinkingParts.push(thoughtContent);
    }

    remaining = remaining.slice(endIdx + '<ctrl95>'.length);
  }

  const text = sawThoughtBlock ? remaining.replace(/^[\r\n]+/, '') : raw;
  const thinking =
    thinkingParts.length > 0 ? thinkingParts.join('\n\n') : undefined;

  return {
    text,
    ...(thinking ? { thinking } : {}),
  };
}

export function parseGeneration(frames: readonly unknown[]): WebGeneration {
  let latestText: string | undefined;
  let found = false;

  for (const frame of frames) {
    const items: unknown[] = Array.isArray(frame) ? frame : [frame];

    for (const item of items) {
      if (!Array.isArray(item)) {
        if (containsBardErrorTag(item)) {
          throw new GeminiWebError('protocol');
        }
        continue;
      }

      if (extractStructuredBardError(item)) {
        throw new GeminiWebError('protocol');
      }

      if (item.length < 3) continue;

      const rawPayload = item[2];
      let payload: unknown;
      if (typeof rawPayload === 'string') {
        try {
          payload = JSON.parse(rawPayload);
        } catch {
          continue;
        }
      } else {
        payload = rawPayload;
      }

      if (!Array.isArray(payload)) continue;

      // 1. Classic candidates snapshot at payload[4]
      if (payload.length > 4 && Array.isArray(payload[4]) && payload[4].length > 0) {
        const firstCandidate = payload[4][0];
        if (Array.isArray(firstCandidate) && firstCandidate.length >= 2 && Array.isArray(firstCandidate[1])) {
          const parts = firstCandidate[1];
          if (parts.length > 0 && typeof parts[0] === 'string') {
            latestText = parts[0];
            found = true;
          }
        }
      }

      // 2. Numbered payload update at payload[2]["7"]
      if (payload.length >= 3 && payload[2] && typeof payload[2] === 'object' && !Array.isArray(payload[2])) {
        const fields = payload[2] as Record<string, unknown>;
        const parts = fields['7'];
        if (Array.isArray(parts) && parts.length > 0 && typeof parts[0] === 'string') {
          latestText = parts[0];
          found = true;
        }
      }
    }
  }

  if (!found || latestText === undefined) {
    throw new GeminiWebError('protocol');
  }

  const extracted = extractThinkingAndText(latestText);
  return {
    text: extracted.text,
    ...(extracted.thinking ? { thinking: extracted.thinking } : {}),
  };
}

function replayTranscript(messages: readonly Message[]): {
  hasSystem: boolean;
  systemPrompt: string;
  tools: Tool[];
} {
  const contentParts: string[] = [];
  const sections = new Map<string, string>();
  const tools = new Map<string, Tool>();
  let hasSystem = false;

  for (const msg of messages) {
    if (msg.role !== 'system') continue;
    hasSystem = true;
    const sys = msg as any;
    if (typeof sys.content === 'string' && sys.content.length > 0) {
      contentParts.push(sys.content);
    } else if (Array.isArray(sys.content)) {
      for (const part of sys.content) {
        if (typeof part === 'string' && part.length > 0) {
          contentParts.push(part);
        } else if (part && typeof part.text === 'string' && part.text.length > 0) {
          contentParts.push(part.text);
        }
      }
    }

    if (sys.sections && typeof sys.sections === 'object') {
      for (const [name, val] of Object.entries(sys.sections)) {
        if (val === null) {
          sections.delete(name);
        } else if (typeof val === 'string') {
          sections.set(name, val);
        }
      }
    }

    if (Array.isArray(sys.toolsRemoved)) {
      for (const rem of sys.toolsRemoved) {
        if (rem && typeof rem.name === 'string') {
          tools.delete(rem.name);
        }
      }
    }

    if (Array.isArray(sys.toolsAdded)) {
      for (const add of sys.toolsAdded) {
        if (add && typeof add.name === 'string') {
          tools.set(add.name, add);
        }
      }
    }
  }

  let prompt = contentParts.join('\n\n');
  if (sections.size > 0) {
    const rendered = [...sections.entries()]
      .map(([name, body]) => `## ${name}\n\n${body}`)
      .join('\n\n');
    prompt = prompt ? `${prompt}\n\n${rendered}` : rendered;
  }

  return {
    hasSystem,
    systemPrompt: prompt,
    tools: [...tools.values()],
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        texts.push(part);
      } else if (part && typeof part === 'object') {
        const item = part as Record<string, unknown>;
        if (item.type === 'image' || item.type === 'image_url') {
          throw new GeminiWebError('unsupported');
        }
        if (typeof item.text === 'string') {
          texts.push(item.text);
        }
      }
    }
    return texts.join('\n');
  }
  if (content && typeof content === 'object') {
    const item = content as Record<string, unknown>;
    if (item.type === 'image' || item.type === 'image_url') {
      throw new GeminiWebError('unsupported');
    }
    if (typeof item.text === 'string') {
      return item.text;
    }
  }
  return '';
}

export function preparePrompt(context: Context, toolChoice?: 'auto' | 'none'): PreparedPrompt {
  const replayed = replayTranscript(context.messages);

  let systemPrompt: string;
  let availableTools: Tool[];

  if (replayed.hasSystem) {
    systemPrompt = replayed.systemPrompt;
    availableTools = replayed.tools;
  } else {
    systemPrompt = context.systemPrompt ?? '';
    availableTools = context.tools ? [...context.tools] : [];
  }

  const activeTools = toolChoice === 'none' ? [] : availableTools;

  // Identify failed/aborted assistant turns to skip them and their results consistently
  const skippedCallIds = new Set<string>();
  for (const msg of context.messages) {
    if (msg.role === 'assistant') {
      const asst = msg as any;
      if (
        asst.stopReason === 'error' ||
        asst.stopReason === 'aborted' ||
        asst.stopReason === 'abort' ||
        asst.errorMessage
      ) {
        if (Array.isArray(asst.content)) {
          for (const part of asst.content) {
            if (part && typeof part === 'object' && part.type === 'toolCall' && part.id) {
              skippedCallIds.add(part.id);
            }
          }
        }
        if (Array.isArray(asst.toolCalls)) {
          for (const tc of asst.toolCalls) {
            if (tc?.id) skippedCallIds.add(tc.id);
          }
        }
      }
    }
  }

  const records: unknown[] = [];

  for (const msg of context.messages) {
    if (msg.role === 'system') {
      continue;
    }

    if (msg.role === 'assistant') {
      const asst = msg as any;
      if (
        asst.stopReason === 'error' ||
        asst.stopReason === 'aborted' ||
        asst.stopReason === 'abort' ||
        asst.errorMessage
      ) {
        continue;
      }
      const text = extractTextContent(asst.content);
      const calls: unknown[] = [];
      if (Array.isArray(asst.content)) {
        for (const part of asst.content) {
          if (part && typeof part === 'object' && part.type === 'toolCall') {
            calls.push({
              id: part.id,
              name: part.name,
              arguments: part.arguments,
            });
          }
        }
      }
      if (Array.isArray(asst.toolCalls)) {
        for (const tc of asst.toolCalls) {
          if (tc && typeof tc === 'object' && !calls.some((c: any) => c.id === tc.id)) {
            calls.push({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            });
          }
        }
      }
      if (text || calls.length > 0) {
        records.push({
          role: 'assistant',
          ...(text ? { content: text } : {}),
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        });
      }
      continue;
    }

    if (msg.role === 'toolResult' || (msg.role as string) === 'tool_result' || (msg as any).role === 'tool') {
      const tr = msg as any;
      const callId = tr.toolCallId || tr.tool_call_id;
      if (callId && skippedCallIds.has(callId)) {
        continue;
      }
      const text = extractTextContent(tr.content);
      records.push({
        role: 'tool_result',
        ...(callId ? { tool_call_id: callId } : {}),
        ...(tr.toolName ? { tool_name: tr.toolName } : {}),
        content: text,
        is_error: Boolean(tr.isError),
      });
      continue;
    }

    if (msg.role === 'user') {
      const text = extractTextContent(msg.content);
      records.push({
        role: 'user',
        content: text,
      });
    }
  }

  const promptSections: string[] = [];

  if (systemPrompt.length > 0) {
    promptSections.push(systemPrompt);
  }

  if (activeTools.length > 0) {
    const toolDeclarations = activeTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const instructions = [
      'You are equipped with the following external tools:',
      JSON.stringify(toolDeclarations, null, 2),
      '',
      'RESPONSE FORMAT INSTRUCTIONS:',
      'When replying, you MUST choose exactly ONE of these two response shapes, with no other text:',
      '1. To reply to the user with plain text:',
      '{"content": "your response message here"}',
      '',
      '2. To invoke one or more tools (up to 16):',
      '{"tool_calls": [{"name": "tool_name", "arguments": { ... }}]}',
      '',
      'CRITICAL RULES:',
      '- Output ONLY the single exact JSON object. Do not include markdown commentary before or after.',
      '- Never mix "content" and "tool_calls" in the same response.',
      '- Provide valid JSON arguments matching the tool parameters schema.',
    ].join('\n');

    promptSections.push(instructions);
  }

  promptSections.push(
    `CONVERSATION TRANSCRIPT (chronological JSON records):\n${JSON.stringify(records, null, 2)}`,
  );

  return {
    payload: {
      prompt: promptSections.join('\n\n'),
    },
    tools: activeTools,
  };
}

export function decodeReply(text: string, tools: readonly Tool[], idPrefix: string): DecodedReply {
  if (tools.length === 0) {
    return { text, toolCalls: [] };
  }

  let trimmed = text.trim();

  // Strip code fence if the entire string is wrapped in one
  const codeFenceMatch = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  if (codeFenceMatch) {
    trimmed = codeFenceMatch[1].trim();
  }

  // If it doesn't start with { and end with }, it is not an exact envelope
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    // Check for recognizable malformed/partial bridge output that attempted tool calling
    if (
      trimmed.startsWith('{') &&
      (trimmed.includes('"tool_calls"') || trimmed.includes('"tool_call"') || trimmed.includes('"content"'))
    ) {
      throw new GeminiWebError('tools');
    }
    // Ordinary non-envelope prose stays text
    return { text, toolCalls: [] };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Malformed JSON that starts with { and contains bridge keywords is recognizable malformed bridge output
    if (
      trimmed.includes('"tool_calls"') ||
      trimmed.includes('"tool_call"') ||
      trimmed.includes('"content"')
    ) {
      throw new GeminiWebError('tools');
    }
    return { text, toolCalls: [] };
  }

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { text, toolCalls: [] };
  }

  const envelope = obj as Record<string, unknown>;
  const keys = Object.keys(envelope);

  // Mixed content and tool_calls
  if (keys.includes('content') && keys.includes('tool_calls')) {
    throw new GeminiWebError('tools');
  }

  // Exact content envelope
  if (keys.includes('content')) {
    if (keys.length > 1) {
      throw new GeminiWebError('tools');
    }
    if (typeof envelope.content !== 'string') {
      throw new GeminiWebError('tools');
    }
    return { text: envelope.content, toolCalls: [] };
  }

  // Exact tool_calls envelope
  if (keys.includes('tool_calls')) {
    if (keys.length > 1) {
      throw new GeminiWebError('tools');
    }
    const rawCalls = envelope.tool_calls;
    if (!Array.isArray(rawCalls) || rawCalls.length === 0 || rawCalls.length > 16) {
      throw new GeminiWebError('tools');
    }

    const toolCalls: ToolCall[] = [];
    for (let i = 0; i < rawCalls.length; i++) {
      const item = rawCalls[i];
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new GeminiWebError('tools');
      }

      // Reject model-supplied IDs
      if (item.id !== undefined) {
        throw new GeminiWebError('tools');
      }

      if (typeof item.name !== 'string' || !item.name) {
        throw new GeminiWebError('tools');
      }

      // Must be an advertised tool
      const toolDef = tools.find((t) => t.name === item.name);
      if (!toolDef) {
        throw new GeminiWebError('tools');
      }

      // Arguments must be an object (not null, not array, not string)
      if (
        typeof item.arguments !== 'object' ||
        item.arguments === null ||
        Array.isArray(item.arguments)
      ) {
        throw new GeminiWebError('tools');
      }

      const assignedId = `${idPrefix}_${i}`;
      const unvalidated: ToolCall = {
        type: 'toolCall',
        id: assignedId,
        name: item.name,
        arguments: item.arguments as Record<string, any>,
      };

      let validatedArgs: any;
      try {
        validatedArgs = validateToolCall([...tools], unvalidated);
      } catch {
        // Exception includes arguments: never display verbatim or rethrow raw
        throw new GeminiWebError('tools');
      }

      toolCalls.push({
        type: 'toolCall',
        id: assignedId,
        name: item.name,
        arguments: validatedArgs,
      });
    }

    return { text: '', toolCalls };
  }

  // Recognizable bridge attempts with wrong envelope keys
  if (
    keys.includes('tool_call') ||
    keys.includes('tools') ||
    keys.includes('function_call') ||
    (keys.includes('name') && keys.includes('arguments'))
  ) {
    throw new GeminiWebError('tools');
  }

  // Non-envelope JSON object stays text
  return { text, toolCalls: [] };
}
