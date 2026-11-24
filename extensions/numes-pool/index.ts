import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openAICompletionsApi } from '@earendil-works/pi-ai/compat';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

const CHAT_URL = 'https://api.numes.ai/api/v1/chat/completions';
const KEY_FILE = 'numes-pool.keys';

function readKeys() {
  let fd: number;
  try {
    fd = openSync(join(getAgentDir(), KEY_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Cannot open private ${KEY_FILE}.`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error();
    const keys = readFileSync(fd, 'utf8')
      .split('\n')
      .map((key) => key.trim())
      .filter(Boolean);
    if (!keys.length || keys.some((key) => !/^sk-numes-v1-[0-9a-f]+$/i.test(key))) throw new Error();
    return [...new Set(keys)];
  } catch {
    throw new Error(`Invalid ${KEY_FILE}. Use an owner-only 0600 file with one Numes key per line.`);
  } finally {
    closeSync(fd);
  }
}

function poolError(status: number, message: string, retryAfter?: number) {
  const headers = retryAfter === undefined ? undefined : { 'Retry-After': String(retryAfter) };
  return Response.json({ error: { message } }, { status, headers });
}

export function createNumesPoolFetch(keys: readonly string[], now = Date.now) {
  // ponytail: rotation, rejected keys, and cooldown are process-local; share state only if coordination is needed.
  const rejected = new Set<string>();
  let cursor = 0;
  let blockedUntil = 0;
  return (send: typeof fetch): typeof fetch =>
    async (input, init) => {
      if (
        input instanceof Request ||
        new URL(input).href !== CHAT_URL ||
        init?.method !== 'POST' ||
        typeof init.body !== 'string'
      ) {
        throw new Error('Numes Pool refused an unexpected request.');
      }
      const start = cursor++ % keys.length;
      const headers = new Headers(init.headers);
      for (let offset = 0; offset < keys.length; offset++) {
        init.signal?.throwIfAborted();
        const wait = Math.ceil((blockedUntil - now()) / 1000);
        if (wait > 0) return poolError(429, `Numes Pool is cooling down. Retry in ${wait}s.`, wait);
        const key = keys[(start + offset) % keys.length];
        if (rejected.has(key)) continue;
        headers.set('Authorization', `Bearer ${key}`);
        const response = await send(input, { ...init, headers: new Headers(headers), redirect: 'error' });
        if (response.ok) return response;
        // Do not expose upstream error text or headers, which can echo credentials.
        void response.body?.cancel().catch(() => {});
        if (response.status === 401) {
          rejected.add(key);
          continue;
        }
        if (response.status === 429) {
          const value = response.headers.get('retry-after');
          const time = now();
          const seconds = value?.trim() ? Number(value) : NaN;
          const delay = Number.isFinite(seconds) ? seconds * 1000 : value ? Date.parse(value) - time : NaN;
          blockedUntil = Math.max(blockedUntil, time + (Number.isFinite(delay) ? Math.max(0, delay) : 60_000));
          return poolError(429, 'Numes rate limit reached.', Math.ceil((blockedUntil - time) / 1000));
        }
        const status = response.status >= 400 ? response.status : 502;
        return poolError(status, `Numes request failed (HTTP ${status}).`);
      }
      return poolError(401, `All Numes Pool keys were rejected. Replace the keys in ${KEY_FILE} and reload Pi.`);
    };
}

export default function numesPool(pi: ExtensionAPI) {
  const keys = readKeys();
  if (!keys) return;
  const wrapFetch = createNumesPoolFetch(keys);
  const completions = openAICompletionsApi();
  pi.registerProvider('numes-pool', {
    name: 'Numes Pool',
    api: 'openai-completions',
    apiKey: 'numes-pool-managed',
    streamSimple: (model, context, options) =>
      completions.streamSimple(model, context, {
        ...options,
        maxRetries: 0,
        fetch: wrapFetch(options?.fetch ?? globalThis.fetch),
      }),
  });
}
