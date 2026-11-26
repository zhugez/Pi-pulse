// Adapted from gemini-web-to-api (https://github.com/ntthanh2603/gemini-web-to-api)
// Pinned upstream commit: 1f1577dbd479d5b61a1c5f03de742ffcdeb51f6d
// Copyright (c) 2025 Nguyễn Tuấn Thành
// Licensed under the MIT License.

import { randomUUID } from 'node:crypto';
import type { CookieCredential, CookieCredentialStore } from './auth.js';
import {
  GeminiWebError,
  buildDiscoveryRequest,
  buildGenerateRequest,
  decodeWebFrames,
  parseBootstrap,
  parseGeneration,
  parseModelCatalog,
  type WebBootstrap,
  type WebGeneration,
  type WebModel,
  type WebPayload,
  type WebSession,
} from './protocol.js';

export type WebResponseInfo = Readonly<{
  status: number;
  headers: Record<string, string>;
}>;

export type WebRequestOptions = {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
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
  expectedHost: string,
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
    let domain: string | undefined;
    let isDelete = false;

    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i];
      const attrEq = attr.indexOf('=');
      const attrName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
      const attrVal = attrEq === -1 ? '' : attr.slice(attrEq + 1).trim();

      if (attrName === 'secure') {
        isSecure = true;
      } else if (attrName === 'domain') {
        domain = attrVal.toLowerCase().replace(/^\./, '');
      } else if (attrName === 'max-age') {
        const maxAge = Number.parseInt(attrVal, 10);
        if (!Number.isNaN(maxAge) && maxAge <= 0) {
          isDelete = true;
        }
      } else if (attrName === 'expires') {
        const exp = Date.parse(attrVal);
        if (!Number.isNaN(exp) && exp <= Date.now()) {
          isDelete = true;
        }
      }
    }

    if (name.startsWith('__Secure-') && !isSecure) {
      continue;
    }

    if (domain) {
      const cleanExpected = expectedHost.toLowerCase().replace(/^\./, '');
      if (domain !== cleanExpected && !cleanExpected.endsWith(`.${domain}`)) {
        continue;
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

  return existing.map((p) => `${p.name}=${p.value}`).join('; ');
}

function createTimeoutSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
  closeSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new GeminiWebError('network'));
    }, timeoutMs);
  }

  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason);
  };
  const onCloseAbort = () => {
    controller.abort(new GeminiWebError('closed'));
  };

  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  if (closeSignal) {
    if (closeSignal.aborted) onCloseAbort();
    else closeSignal.addEventListener('abort', onCloseAbort, { once: true });
  }

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
    closeSignal?.removeEventListener('abort', onCloseAbort);
  };

  return { signal: controller.signal, cleanup };
}

class AsyncMutex {
  private locked = false;
  private queue: Array<{
    resolve: () => void;
    reject: (err: unknown) => void;
    signal?: AbortSignal;
  }> = [];

  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const item = { resolve, reject, signal };
      const onAbort = () => {
        const idx = this.queue.indexOf(item);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          reject(signal?.reason ?? new GeminiWebError('network'));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push({
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
        signal,
      });
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

  constructor(store: CookieCredentialStore, deps: WebClientDependencies = {}) {
    this.store = store;
    this.deps = deps;
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
    now: number,
  ): void {
    this.cachedBootstrap = {
      revision,
      authUser,
      bootstrap,
      cachedAt: now,
    };
  }

  private async readBoundedBody(
    response: Response,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<string> {
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

    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
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
        await reader.cancel();
      } catch {
        // ignore cancel error
      }
      if (error instanceof GeminiWebError) throw error;
      if (signal?.aborted) throw error;
      throw new GeminiWebError('network');
    } finally {
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
    const activeFetch = options?.fetch ?? this.deps.fetch ?? globalThis.fetch;
    const { signal, cleanup } = createTimeoutSignal(
      options?.timeoutMs ?? 5_000,
      options?.signal,
      this.closeController.signal,
    );

    const pairs = cred.cookieHeader
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean);
    const psid = pairs.find((p) => p.startsWith('__Secure-1PSID='));
    const psidts = pairs.find((p) => p.startsWith('__Secure-1PSIDTS='));

    if (!psid) {
      cleanup();
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
      cleanup();
      if (this.closed) throw new GeminiWebError('closed');
      if (options?.signal?.aborted) throw options.signal.reason;
      throw new GeminiWebError('auth');
    } finally {
      cleanup();
    }

    if ((response.status >= 300 && response.status < 400) || response.status === 0) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }
      throw new GeminiWebError('auth');
    }

    if (response.status !== 200) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }
      throw new GeminiWebError('auth');
    }

    const setCookieHeaders = getSetCookieHeaders(response.headers);
    const updated = mergeSetCookieHeaders(
      cred.cookieHeader,
      setCookieHeaders,
      'accounts.google.com',
    );
    try {
      await response.body?.cancel();
    } catch {
      // ignore cancel error
    }
    return updated !== cred.cookieHeader ? updated : undefined;
  }

  private async doBootstrap(
    cred: CookieCredential,
    options?: Pick<WebRequestOptions, 'signal' | 'fetch' | 'timeoutMs'>,
  ): Promise<{ bootstrap: WebBootstrap; cookieHeader: string }> {
    const activeFetch = options?.fetch ?? this.deps.fetch ?? globalThis.fetch;
    const { signal, cleanup } = createTimeoutSignal(
      options?.timeoutMs ?? 30_000,
      options?.signal,
      this.closeController.signal,
    );

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
      cleanup();
      if (this.closed) throw new GeminiWebError('closed');
      if (options?.signal?.aborted) throw options.signal.reason;
      throw new GeminiWebError('network');
    } finally {
      cleanup();
    }

    if ((response.status >= 300 && response.status < 400) || response.status === 0) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }
      throw new GeminiWebError('auth');
    }
    if (response.status === 401 || response.status === 403) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }
      throw new GeminiWebError('auth');
    }
    if (response.status !== 200) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }
      throw new GeminiWebError('http', response.status);
    }

    const html = await this.readBoundedBody(response, 8 * 1024 * 1024, options?.signal);
    const bootstrap = parseBootstrap(html);
    const setCookieHeaders = getSetCookieHeaders(response.headers);
    const mergedCookie = mergeSetCookieHeaders(
      cred.cookieHeader,
      setCookieHeaders,
      'gemini.google.com',
    );
    return { bootstrap, cookieHeader: mergedCookie };
  }

  private async doDiscovery(
    session: WebSession,
    cookieHeader: string,
    options?: Pick<WebRequestOptions, 'signal' | 'fetch' | 'timeoutMs'>,
  ): Promise<readonly WebModel[]> {
    const activeFetch = options?.fetch ?? this.deps.fetch ?? globalThis.fetch;
    const { signal, cleanup } = createTimeoutSignal(
      options?.timeoutMs ?? 30_000,
      options?.signal,
      this.closeController.signal,
    );

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
      cleanup();
      if (this.closed) throw new GeminiWebError('closed');
      if (options?.signal?.aborted) throw options.signal.reason;
      throw new GeminiWebError('network');
    } finally {
      cleanup();
    }

    if ((response.status >= 300 && response.status < 400) || response.status === 0) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }
      throw new GeminiWebError('auth');
    }
    if (response.status === 401 || response.status === 403) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }
      throw new GeminiWebError('auth');
    }
    if (response.status !== 200) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }
      throw new GeminiWebError('http', response.status);
    }

    const body = await this.readBoundedBody(response, 8 * 1024 * 1024, options?.signal);
    const frames = decodeWebFrames(body);
    const models = parseModelCatalog(frames);
    return models;
  }

  private async getOrFetchBootstrap(
    cred: CookieCredential,
    options?: WebRequestOptions,
  ): Promise<WebBootstrap> {
    const nowFn = this.deps.now ?? Date.now;
    const now = nowFn();

    if (
      this.cachedBootstrap &&
      this.cachedBootstrap.revision === cred.revision &&
      this.cachedBootstrap.authUser === cred.authUser &&
      now - this.cachedBootstrap.cachedAt < 10 * 60 * 1000
    ) {
      return this.cachedBootstrap.bootstrap;
    }

    await this.setupLock.acquire(options?.signal);
    try {
      const currentNow = nowFn();
      if (
        this.cachedBootstrap &&
        this.cachedBootstrap.revision === cred.revision &&
        this.cachedBootstrap.authUser === cred.authUser &&
        currentNow - this.cachedBootstrap.cachedAt < 10 * 60 * 1000
      ) {
        return this.cachedBootstrap.bootstrap;
      }

      const res = await this.doBootstrap(cred, options);
      this.cacheBootstrap(cred.revision, cred.authUser, res.bootstrap, currentNow);
      return res.bootstrap;
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

      this.cacheBootstrap(updatedCred.revision, updatedCred.authUser, bootstrapRes.bootstrap, now);

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

    const cred = await this.store.read(options?.signal);
    if (!cred) {
      throw new GeminiWebError('credentials');
    }

    const model = cred.models.find((m) => m.id === modelId);
    if (!model) {
      throw new GeminiWebError('model');
    }

    const bootstrap = await this.getOrFetchBootstrap(cred, options);
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
    );

    const activeFetch = options?.fetch ?? this.deps.fetch ?? globalThis.fetch;
    const { signal, cleanup } = createTimeoutSignal(
      options?.timeoutMs ?? 300_000,
      options?.signal,
      this.closeController.signal,
    );

    let response: Response;
    try {
      response = await activeFetch(wireRequest.url, {
        method: wireRequest.method,
        headers: {
          ...wireRequest.headers,
          Cookie: cred.cookieHeader,
        },
        body: wireRequest.body,
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      cleanup();
      if (this.closed) throw new GeminiWebError('closed');
      if (options?.signal?.aborted) throw options.signal.reason;
      throw new GeminiWebError('network');
    } finally {
      cleanup();
    }

    if ((response.status >= 300 && response.status < 400) || response.status === 0) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }
      throw new GeminiWebError('auth');
    }

    if (response.status === 401 || response.status === 403) {
      this.cachedBootstrap = undefined;
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }
      throw new GeminiWebError('auth');
    }

    if (response.status !== 200) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }
      throw new GeminiWebError('http', response.status);
    }

    if (options?.onResponse) {
      const safeHeaders = filterSafeHeaders(response.headers);
      await options.onResponse({ status: response.status, headers: safeHeaders });
      options?.signal?.throwIfAborted();
    }

    const bodyText = await this.readBoundedBody(
      response,
      16 * 1024 * 1024,
      options?.signal,
    );

    const frames = decodeWebFrames(bodyText);

    if (options?.onFrame) {
      for (const frame of frames) {
        await options.onFrame(frame);
        options?.signal?.throwIfAborted();
      }
    }

    const generation = parseGeneration(frames);
    return generation;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cachedBootstrap = undefined;
    this.generationIdByRevision.clear();
    this.closeController.abort(new GeminiWebError('closed'));
  }
}

export function createGeminiWebClient(
  store: CookieCredentialStore,
  dependencies?: WebClientDependencies,
): GeminiWebClient {
  return new GeminiWebClientImpl(store, dependencies);
}
