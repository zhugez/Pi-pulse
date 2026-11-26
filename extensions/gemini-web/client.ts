// Adapted from gemini-web-to-api (https://github.com/ntthanh2603/gemini-web-to-api)
// Pinned upstream commit: 1f1577dbd479d5b61a1c5f03de742ffcdeb51f6d
// Copyright (c) 2025 Nguyễn Tuấn Thành
// Licensed under the MIT License.

import { randomUUID } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import type { CookieCredential, CookieCredentialStore } from './auth.js';
import {
  GeminiWebError,
  buildDiscoveryRequest,
  buildGenerateRequest,
  decodeWebFrames,
  getFriendlyModelId,
  parseBootstrap,
  parseGeneration,
  parseModelCatalog,
  validateWebThinkingLevel,
  type WebBootstrap,
  type WebGeneration,
  type WebModel,
  type WebPayload,
  type WebSession,
  type WebThinkingLevel,
} from './protocol.js';

export type WebResponseInfo = Readonly<{
  status: number;
  headers: Record<string, string>;
}>;

export type WebRequestOptions = {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  thinkingLevel?: WebThinkingLevel;
  onPayload?: (payload: WebPayload) => unknown | Promise<unknown>;
  onResponse?: (response: WebResponseInfo) => void | Promise<void>;
  onFrame?: (frame: unknown) => void | Promise<void>;
};

export type WebClientDependencies = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  randomUUID?: () => string;
};

export interface GeminiWebClient {
  refresh(
    options?: Pick<WebRequestOptions, 'signal' | 'fetch' | 'timeoutMs'>,
  ): Promise<readonly WebModel[]>;
  generate(
    modelId: string,
    payload: WebPayload,
    options?: WebRequestOptions,
  ): Promise<WebGeneration>;
  close(): void;
}

const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SAFE_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'retry-after',
  'date',
  'server',
  'x-request-id',
]);

function filterSafeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (SAFE_RESPONSE_HEADERS.has(lower)) {
      result[lower] = value;
    }
  });
  return result;
}

function getSetCookieHeaders(headers: Headers): string[] {
  if (typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function') {
    return (headers as unknown as { getSetCookie: () => string[] }).getSetCookie();
  }
  const raw = headers.get('set-cookie');
  if (!raw) return [];
  return raw.split(/,\s*(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;])/);
}

function mergeSetCookieHeaders(
  currentHeader: string,
  setCookieHeaders: string[],
  source: 'rotation' | 'gemini',
  now: number,
): string {
  if (!setCookieHeaders.length) {
    return currentHeader;
  }
  const existing = currentHeader
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf('=');
      return eq === -1
        ? { name: p, value: '' }
        : { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() };
    });

  for (const raw of setCookieHeaders) {
    const parts = raw
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) continue;
    const first = parts[0];
    const eq = first.indexOf('=');
    if (eq === -1) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) continue;

    let isSecure = false;
    let explicitDomain: string | undefined;
    let path: string | undefined;
    let maxAge: number | undefined;
    let expires: number | undefined;

    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i];
      const attrEq = attr.indexOf('=');
      const attrName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
      const attrVal = attrEq === -1 ? '' : attr.slice(attrEq + 1).trim();

      if (attrName === 'secure') {
        isSecure = true;
      } else if (attrName === 'domain') {
        explicitDomain = attrVal.toLowerCase().replace(/^\./, '');
      } else if (attrName === 'path') {
        path = attrVal;
      } else if (attrName === 'max-age') {
        const parsed = Number.parseInt(attrVal, 10);
        if (!Number.isNaN(parsed)) {
          maxAge = parsed;
        }
      } else if (attrName === 'expires') {
        const parsed = Date.parse(attrVal);
        if (!Number.isNaN(parsed)) {
          expires = parsed;
        }
      }
    }

    if (name.startsWith('__Secure-') && !isSecure) {
      continue;
    }

    // Path boundary: must apply to root '/' so it covers Google/Gemini RPC paths
    if (path !== undefined && path !== '/' && path !== '') {
      continue;
    }

    if (source === 'rotation') {
      // Rotation on accounts.google.com: only accept intended rotation auth cookies
      if (
        name !== '__Secure-1PSIDTS' &&
        name !== '__Secure-1PSID' &&
        name !== '__Secure-3PSIDTS' &&
        name !== '__Secure-3PSID'
      ) {
        continue;
      }
      // Must have explicit shared .google.com / google.com domain; never promote host-only accounts cookies
      if (!explicitDomain || (explicitDomain !== 'google.com' && explicitDomain !== '.google.com')) {
        continue;
      }
    } else if (source === 'gemini') {
      if (explicitDomain && explicitDomain !== 'gemini.google.com' && explicitDomain !== 'google.com') {
        continue;
      }
    }

    // Expiry check: Max-Age takes precedence over Expires
    let isDelete = false;
    if (maxAge !== undefined) {
      if (maxAge <= 0) {
        isDelete = true;
      }
    } else if (expires !== undefined) {
      if (expires <= now) {
        isDelete = true;
      }
    }

    const idx = existing.findIndex((e) => e.name === name);
    if (isDelete) {
      if (idx !== -1) {
        existing.splice(idx, 1);
      }
    } else {
      if (idx !== -1) {
        existing[idx] = { name, value };
      } else {
        existing.push({ name, value });
      }
    }
  }

  // Auth deletion fail-closed: required credentials must remain present
  const hasPsid = existing.some((e) => e.name === '__Secure-1PSID' && e.value.length > 0);
  const hasPsidts = existing.some((e) => e.name === '__Secure-1PSIDTS' && e.value.length > 0);
  if (!hasPsid || !hasPsidts) {
    throw new GeminiWebError('auth');
  }

  return existing.map((e) => `${e.name}=${e.value}`).join('; ');
}

function validateTimeoutMs(timeoutMs?: number, defaultMs = 30_000): number {
  if (timeoutMs === undefined) return defaultMs;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 600_000
  ) {
    throw new GeminiWebError('protocol');
  }
  return timeoutMs;
}

function createTimeoutSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
  closeSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const timeoutController = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timeoutController.abort(new GeminiWebError('network'));
    }, timeoutMs);
  }

  const signals: AbortSignal[] = [timeoutController.signal];
  if (callerSignal) signals.push(callerSignal);
  if (closeSignal) signals.push(closeSignal);
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  const cleanup = () => {
    if (timer) clearTimeout(timer);
  };

  return { signal, cleanup };
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore cancel error
  }
}

async function validateResponseStatus(response: Response): Promise<void> {
  if (response.status === 200) {
    return;
  }
  await cancelResponseBody(response);
  if ((response.status >= 300 && response.status < 400) || response.status === 0) {
    throw new GeminiWebError('auth');
  }
  if (response.status === 401 || response.status === 403) {
    throw new GeminiWebError('auth');
  }
  throw new GeminiWebError('http', response.status);
}

class AsyncMutex {
  private locked = false;
  private queue: Array<{
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];

  async acquire(signal?: AbortSignal, closeSignal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    closeSignal?.throwIfAborted();
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      let entry: { resolve: () => void; reject: (err: unknown) => void };

      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        closeSignal?.removeEventListener('abort', onClose);
      };

      const removeSelf = () => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
      };

      const onAbort = () => {
        cleanup();
        removeSelf();
        reject(signal?.reason ?? new GeminiWebError('network'));
      };

      const onClose = () => {
        cleanup();
        removeSelf();
        reject(new GeminiWebError('closed'));
      };

      entry = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (err: unknown) => {
          cleanup();
          reject(err);
        },
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (closeSignal) {
        if (closeSignal.aborted) {
          onClose();
          return;
        }
        closeSignal.addEventListener('abort', onClose, { once: true });
      }

      this.queue.push(entry);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.resolve();
    } else {
      this.locked = false;
    }
  }
}

type CachedBootstrap = Readonly<{
  revision: string;
  authUser: number;
  bootstrap: WebBootstrap;
  cookieHeader: string;
  cachedAt: number;
}>;

class GeminiWebClientImpl implements GeminiWebClient {
  private readonly store: CookieCredentialStore;
  private readonly deps: WebClientDependencies;
  private closed = false;
  private readonly closeController = new AbortController();
  private readonly setupLock = new AsyncMutex();
  private cachedBootstrap?: CachedBootstrap;
  private generationIdByRevision = new Map<string, string>();
  private requestCounter = 100000;
  private defaultTransport?: {
    fetch: typeof globalThis.fetch;
    destroy: () => Promise<void>;
  };

  constructor(store: CookieCredentialStore, deps: WebClientDependencies = {}) {
    this.store = store;
    this.deps = deps;
  }

  private getEffectiveFetch(
    optionsFetch?: typeof globalThis.fetch,
  ): typeof globalThis.fetch {
    if (optionsFetch) return optionsFetch;
    if (this.deps.fetch) return this.deps.fetch;
    if (!this.defaultTransport) {
      this.defaultTransport = createDefaultFetchTransport();
    }
    return this.defaultTransport.fetch;
  }

  private nextRequestNumber(): number {
    return this.requestCounter++;
  }

  private getGenerationId(revision: string): string {
    let id = this.generationIdByRevision.get(revision);
    if (!id) {
      const uuidFn = this.deps.randomUUID ?? randomUUID;
      id = uuidFn();
      this.generationIdByRevision.set(revision, id);
    }
    return id;
  }

  private cacheBootstrap(
    revision: string,
    authUser: number,
    bootstrap: WebBootstrap,
    cookieHeader: string,
    now: number,
  ): void {
    this.cachedBootstrap = {
      revision,
      authUser,
      bootstrap,
      cookieHeader,
      cachedAt: now,
    };
  }

  private async readBoundedBody(
    response: Response,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.closed) throw new GeminiWebError('closed');
    signal?.throwIfAborted();
    if (!response.body) {
      if (typeof response.text === 'function') {
        const text = await response.text();
        if (Buffer.byteLength(text) > maxBytes) {
          throw new GeminiWebError('protocol');
        }
        return text;
      }
      return '';
    }

    if (typeof response.body.getReader !== 'function') {
      const text = await response.text();
      if (Buffer.byteLength(text) > maxBytes) {
        throw new GeminiWebError('protocol');
      }
      return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let totalBytes = 0;
    let result = '';

    const onAbort = () => {
      try {
        void reader.cancel(signal?.reason);
      } catch {
        // ignore
      }
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      while (true) {
        if (this.closed) throw new GeminiWebError('closed');
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (this.closed) throw new GeminiWebError('closed');
        signal?.throwIfAborted();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              // ignore cancel error
            }
            throw new GeminiWebError('protocol');
          }
          result += decoder.decode(value, { stream: true });
        }
      }
      result += decoder.decode();
      return result;
    } catch (error) {
      try {
        await reader.cancel(signal?.reason);
      } catch {
        // ignore cancel error
      }
      if (this.closed) throw new GeminiWebError('closed');
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof GeminiWebError) throw error;
      throw new GeminiWebError('network');
    } finally {
      signal?.removeEventListener('abort', onAbort);
      try {
        reader.releaseLock();
      } catch {
        // ignore lock release error
      }
    }
  }

  private async rotateCookies(
    cred: CookieCredential,
    options?: Pick<WebRequestOptions, 'signal' | 'fetch' | 'timeoutMs'>,
  ): Promise<string | undefined> {
    const timeoutMs = validateTimeoutMs(options?.timeoutMs, 5_000);
    const activeFetch = this.getEffectiveFetch(options?.fetch);
    const { signal, cleanup } = createTimeoutSignal(
      timeoutMs,
      options?.signal,
      this.closeController.signal,
    );

    try {
      const pairs = cred.cookieHeader
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean);
      const psid = pairs.find((p) => p.startsWith('__Secure-1PSID='));
      const psidts = pairs.find((p) => p.startsWith('__Secure-1PSIDTS='));

      if (!psid) {
        throw new GeminiWebError('credentials');
      }

      const narrowParts = [psid];
      if (psidts) {
        narrowParts.push(psidts);
      }
      const narrowCookie = narrowParts.join('; ');

      let response: Response;
      try {
        response = await activeFetch('https://accounts.google.com/RotateCookies', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': CHROME_USER_AGENT,
            Cookie: narrowCookie,
          },
          body: '[000,"-0000000000000000000"]',
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (this.closed) throw new GeminiWebError('closed');
        if (options?.signal?.aborted) throw options.signal.reason;
        throw new GeminiWebError('auth');
      }

      if ((response.status >= 300 && response.status < 400) || response.status === 0) {
        await cancelResponseBody(response);
        throw new GeminiWebError('auth');
      }

      if (response.status !== 200) {
        await cancelResponseBody(response);
        throw new GeminiWebError('auth');
      }

      const setCookieHeaders = getSetCookieHeaders(response.headers);
      const nowFn = this.deps.now ?? Date.now;
      const updated = mergeSetCookieHeaders(
        cred.cookieHeader,
        setCookieHeaders,
        'rotation',
        nowFn(),
      );
      await cancelResponseBody(response);
      return updated !== cred.cookieHeader ? updated : undefined;
    } finally {
      cleanup();
    }
  }

  private async doBootstrap(
    cred: CookieCredential,
    options?: Pick<WebRequestOptions, 'signal' | 'fetch' | 'timeoutMs'>,
  ): Promise<{ bootstrap: WebBootstrap; cookieHeader: string }> {
    const timeoutMs = validateTimeoutMs(options?.timeoutMs, 30_000);
    const activeFetch = this.getEffectiveFetch(options?.fetch);
    const { signal, cleanup } = createTimeoutSignal(
      timeoutMs,
      options?.signal,
      this.closeController.signal,
    );

    try {
      const url = `https://gemini.google.com/u/${cred.authUser}/app?hl=en`;
      let response: Response;
      try {
        response = await activeFetch(url, {
          method: 'GET',
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            Origin: 'https://gemini.google.com',
            Referer: 'https://gemini.google.com/',
            'User-Agent': CHROME_USER_AGENT,
            'X-Same-Domain': '1',
            Cookie: cred.cookieHeader,
          },
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (this.closed) throw new GeminiWebError('closed');
        if (options?.signal?.aborted) throw options.signal.reason;
        throw new GeminiWebError('network');
      }

      await validateResponseStatus(response);

      const html = await this.readBoundedBody(response, 8 * 1024 * 1024, signal);
      const bootstrap = parseBootstrap(html);
      const setCookieHeaders = getSetCookieHeaders(response.headers);
      const nowFn = this.deps.now ?? Date.now;
      const mergedCookie = mergeSetCookieHeaders(
        cred.cookieHeader,
        setCookieHeaders,
        'gemini',
        nowFn(),
      );
      return { bootstrap, cookieHeader: mergedCookie };
    } finally {
      cleanup();
    }
  }

  private async doDiscovery(
    session: WebSession,
    cookieHeader: string,
    options?: Pick<WebRequestOptions, 'signal' | 'fetch' | 'timeoutMs'>,
  ): Promise<readonly WebModel[]> {
    const timeoutMs = validateTimeoutMs(options?.timeoutMs, 30_000);
    const activeFetch = this.getEffectiveFetch(options?.fetch);
    const { signal, cleanup } = createTimeoutSignal(
      timeoutMs,
      options?.signal,
      this.closeController.signal,
    );

    try {
      const reqNumber = this.nextRequestNumber();
      const wireReq = buildDiscoveryRequest(session, reqNumber);

      let response: Response;
      try {
        response = await activeFetch(wireReq.url, {
          method: wireReq.method,
          headers: {
            ...wireReq.headers,
            Cookie: cookieHeader,
          },
          body: wireReq.body,
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (this.closed) throw new GeminiWebError('closed');
        if (options?.signal?.aborted) throw options.signal.reason;
        throw new GeminiWebError('network');
      }

      await validateResponseStatus(response);

      const body = await this.readBoundedBody(response, 8 * 1024 * 1024, signal);
      const frames = decodeWebFrames(body);
      const models = parseModelCatalog(frames);
      return models;
    } finally {
      cleanup();
    }
  }

  private async getOrFetchBootstrap(
    cred: CookieCredential,
    options?: WebRequestOptions,
  ): Promise<{ bootstrap: WebBootstrap; cookieHeader: string }> {
    const nowFn = this.deps.now ?? Date.now;
    const now = nowFn();

    if (
      this.cachedBootstrap &&
      this.cachedBootstrap.revision === cred.revision &&
      this.cachedBootstrap.authUser === cred.authUser &&
      now - this.cachedBootstrap.cachedAt < 10 * 60 * 1000
    ) {
      return {
        bootstrap: this.cachedBootstrap.bootstrap,
        cookieHeader: this.cachedBootstrap.cookieHeader,
      };
    }

    await this.setupLock.acquire(options?.signal, this.closeController.signal);
    try {
      if (this.closed) throw new GeminiWebError('closed');
      const currentNow = nowFn();
      if (
        this.cachedBootstrap &&
        this.cachedBootstrap.revision === cred.revision &&
        this.cachedBootstrap.authUser === cred.authUser &&
        currentNow - this.cachedBootstrap.cachedAt < 10 * 60 * 1000
      ) {
        return {
          bootstrap: this.cachedBootstrap.bootstrap,
          cookieHeader: this.cachedBootstrap.cookieHeader,
        };
      }

      const res = await this.doBootstrap(cred, options);
      this.cacheBootstrap(
        cred.revision,
        cred.authUser,
        res.bootstrap,
        res.cookieHeader,
        currentNow,
      );

      if (res.cookieHeader !== cred.cookieHeader) {
        await this.store.update((current) => {
          if (
            !current ||
            current.revision !== cred.revision ||
            current.authUser !== cred.authUser
          ) {
            return current; // identity changed, do not overwrite replacement
          }
          return {
            ...current,
            cookieHeader: res.cookieHeader,
            updatedAt: currentNow,
          };
        }, options?.signal);
      }

      return res;
    } finally {
      this.setupLock.release();
    }
  }

  async refresh(
    options?: Pick<WebRequestOptions, 'signal' | 'fetch' | 'timeoutMs'>,
  ): Promise<readonly WebModel[]> {
    if (this.closed) {
      throw new GeminiWebError('closed');
    }

    const nowFn = this.deps.now ?? Date.now;
    let resultingModels: readonly WebModel[] = [];

    await this.store.update(async (current) => {
      if (!current) {
        throw new GeminiWebError('credentials');
      }

      const now = nowFn();
      const lastAttempt = current.lastRotationAt ?? current.updatedAt;
      const isDue = now - lastAttempt >= 24 * 60 * 60 * 1000;
      const recentlyAttempted =
        current.lastRotationAt !== undefined && now - current.lastRotationAt < 10 * 60 * 1000;

      let updatedCred: CookieCredential = { ...current };
      let rotationAttempted = false;

      if (isDue && !recentlyAttempted) {
        rotationAttempted = true;
        updatedCred = {
          ...updatedCred,
          lastRotationAt: now,
        };
        try {
          const rotatedCookie = await this.rotateCookies(updatedCred, options);
          if (rotatedCookie) {
            updatedCred = {
              ...updatedCred,
              cookieHeader: rotatedCookie,
              updatedAt: now,
            };
          }
        } catch {
          // Rotation failure still independently verifies Gemini; rotation 200 alone is insufficient.
        }
      }

      // Persist rotated credentials before bootstrap/discovery so rotated tokens survive failure
      if (rotationAttempted) {
        await this.store.save(updatedCred);
      }

      const bootstrapRes = await this.doBootstrap(updatedCred, options);
      if (bootstrapRes.cookieHeader !== updatedCred.cookieHeader) {
        updatedCred = {
          ...updatedCred,
          cookieHeader: bootstrapRes.cookieHeader,
          updatedAt: now,
        };
        await this.store.save(updatedCred);
      }

      this.cacheBootstrap(
        updatedCred.revision,
        updatedCred.authUser,
        bootstrapRes.bootstrap,
        updatedCred.cookieHeader,
        now,
      );

      const session: WebSession = {
        ...bootstrapRes.bootstrap,
        authUser: updatedCred.authUser,
        generationId: this.getGenerationId(updatedCred.revision),
      };

      const models = await this.doDiscovery(session, updatedCred.cookieHeader, options);
      updatedCred = {
        ...updatedCred,
        models,
        catalogCheckedAt: now,
      };
      resultingModels = models;
      return updatedCred;
    }, options?.signal);

    return resultingModels;
  }

  async generate(
    modelId: string,
    payload: WebPayload,
    options?: WebRequestOptions,
  ): Promise<WebGeneration> {
    if (this.closed) {
      throw new GeminiWebError('closed');
    }
    if (typeof payload?.prompt !== 'string') {
      throw new GeminiWebError('protocol');
    }

    const validatedThinking = validateWebThinkingLevel(options?.thinkingLevel);

    const cred = await this.store.read(options?.signal);
    if (!cred) {
      throw new GeminiWebError('credentials');
    }

    let model = cred.models.find((m) => m.id === modelId);
    if (!model) {
      model = cred.models.find(
        (m) => getFriendlyModelId(m, cred.models) === modelId,
      );
    }
    if (!model) {
      throw new GeminiWebError('model');
    }

    const { bootstrap, cookieHeader: effectiveCookieHeader } =
      await this.getOrFetchBootstrap(cred, options);
    if (this.closed) throw new GeminiWebError('closed');
    options?.signal?.throwIfAborted();

    let effectivePayload: WebPayload = payload;
    if (options?.onPayload) {
      const hookRes = await options.onPayload({ prompt: payload.prompt });
      if (hookRes !== undefined) {
        if (
          typeof hookRes === 'object' &&
          hookRes !== null &&
          'prompt' in hookRes &&
          typeof (hookRes as { prompt: unknown }).prompt === 'string'
        ) {
          effectivePayload = { prompt: (hookRes as { prompt: string }).prompt };
        } else {
          throw new GeminiWebError('protocol');
        }
      }
    }
    if (this.closed) throw new GeminiWebError('closed');
    options?.signal?.throwIfAborted();

    const session: WebSession = {
      ...bootstrap,
      authUser: cred.authUser,
      generationId: this.getGenerationId(cred.revision),
    };

    const uuidFn = this.deps.randomUUID ?? randomUUID;
    const requestId = uuidFn();
    const requestNumber = this.nextRequestNumber();
    const wireRequest = buildGenerateRequest(
      session,
      model,
      effectivePayload,
      requestId,
      requestNumber,
      validatedThinking,
    );

    const timeoutMs = validateTimeoutMs(options?.timeoutMs, 300_000);
    const activeFetch = this.getEffectiveFetch(options?.fetch);
    const { signal, cleanup } = createTimeoutSignal(
      timeoutMs,
      options?.signal,
      this.closeController.signal,
    );

    try {
      let response: Response;
      try {
        response = await activeFetch(wireRequest.url, {
          method: wireRequest.method,
          headers: {
            ...wireRequest.headers,
            Cookie: effectiveCookieHeader,
          },
          body: wireRequest.body,
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (this.closed) throw new GeminiWebError('closed');
        if (options?.signal?.aborted) throw options.signal.reason;
        throw new GeminiWebError('network');
      }

      if (response.status === 401 || response.status === 403) {
        this.cachedBootstrap = undefined;
      }
      await validateResponseStatus(response);

      if (options?.onResponse) {
        const safeHeaders = filterSafeHeaders(response.headers);
        await options.onResponse({ status: response.status, headers: safeHeaders });
        if (this.closed) throw new GeminiWebError('closed');
        signal.throwIfAborted();
        options?.signal?.throwIfAborted();
      }

      const bodyText = await this.readBoundedBody(
        response,
        16 * 1024 * 1024,
        signal,
      );

      const frames = decodeWebFrames(bodyText);

      if (options?.onFrame) {
        for (const frame of frames) {
          await options.onFrame(frame);
          if (this.closed) throw new GeminiWebError('closed');
          signal.throwIfAborted();
          options?.signal?.throwIfAborted();
        }
      }

      const generation = parseGeneration(frames);
      return generation;
    } catch (error) {
      if (this.closed) throw new GeminiWebError('closed');
      if (options?.signal?.aborted) throw options.signal.reason;
      if (this.closeController.signal.aborted) throw new GeminiWebError('closed');
      if (error instanceof GeminiWebError) throw error;
      if (signal.aborted) throw new GeminiWebError('network'); // timeout
      throw error;
    } finally {
      cleanup();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cachedBootstrap = undefined;
    this.generationIdByRevision.clear();
    this.closeController.abort(new GeminiWebError('closed'));
    if (this.defaultTransport) {
      void this.defaultTransport.destroy().catch(() => {});
      this.defaultTransport = undefined;
    }
  }
}

export function createDefaultFetchTransport(): {
  fetch: typeof globalThis.fetch;
  destroy: () => Promise<void>;
} {
  const agent = new Agent({
    maxHeaderSize: 64 * 1024,
  });

  const customFetch = (input: string | URL | Request, init?: RequestInit) => {
    return undiciFetch(input as any, {
      ...(init as any),
      dispatcher: agent,
    }) as unknown as Promise<Response>;
  };

  return {
    fetch: customFetch as typeof globalThis.fetch,
    destroy: async () => {
      await agent.destroy();
    },
  };
}

export function createGeminiWebClient(
  store: CookieCredentialStore,
  dependencies?: WebClientDependencies,
): GeminiWebClient {
  return new GeminiWebClientImpl(store, dependencies);
}
