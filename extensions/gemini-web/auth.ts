// Adapted from gemini-web-to-api (https://github.com/ntthanh2603/gemini-web-to-api)
// Pinned upstream commit: 1f1577dbd479d5b61a1c5f03de742ffcdeb51f6d
// Copyright (c) 2025 Nguyễn Tuấn Thành
// Licensed under the MIT License.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { GeminiWebError, type WebModel } from './protocol.js';

export type CookieCredential = Readonly<{
  version: 1;
  revision: string; // UUID changes on import/replaced identity
  cookieHeader: string; // sensitive full header
  authUser: number;
  updatedAt: number;
  lastRotationAt?: number; // latest attempted rotation, for backoff cadence
  models: readonly WebModel[]; // bound to this imported cookie identity
  catalogCheckedAt?: number;
}>;

const MAX_HEADER_LENGTH = 64 * 1024; // 64 KiB
const MAX_STORE_LENGTH = 256 * 1024; // 256 KiB
const MAX_MODELS_COUNT = 64;

const BANNED_COOKIE_ATTRS = new Set([
  'domain',
  'path',
  'expires',
  'max-age',
  'secure',
  'httponly',
  'samesite',
  'priority',
]);

const COOKIE_NAME_REGEX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function parseCookieImport(
  header: string,
  authUser: number,
  now: number,
  revision: string,
): CookieCredential {
  if (typeof header !== 'string') {
    throw new GeminiWebError('credentials');
  }
  if (Buffer.byteLength(header) > MAX_HEADER_LENGTH) {
    throw new GeminiWebError('credentials');
  }
  if (typeof authUser !== 'number' || !Number.isSafeInteger(authUser) || authUser < 0) {
    throw new GeminiWebError('credentials');
  }
  if (typeof revision !== 'string' || !revision.trim()) {
    throw new GeminiWebError('credentials');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new GeminiWebError('credentials');
  }

  let trimmed = header.trim();
  if (/^cookie:\s*/i.test(trimmed)) {
    trimmed = trimmed.replace(/^cookie:\s*/i, '').trim();
  }

  // Reject embedded controls, newlines, or null bytes
  if (/[\r\n\x00-\x1f\x7f]/.test(trimmed)) {
    throw new GeminiWebError('credentials');
  }

  const rawParts = trimmed.split(';');
  const seenNames = new Set<string>();
  const pairs: Array<{ name: string; value: string }> = [];

  for (const rawPart of rawParts) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    const eq = part.indexOf('=');
    if (eq === -1) {
      throw new GeminiWebError('credentials');
    }
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) {
      throw new GeminiWebError('credentials');
    }
    if (!COOKIE_NAME_REGEX.test(name)) {
      throw new GeminiWebError('credentials');
    }
    const lowerName = name.toLowerCase();
    if (BANNED_COOKIE_ATTRS.has(lowerName)) {
      throw new GeminiWebError('credentials');
    }
    if (seenNames.has(name)) {
      throw new GeminiWebError('credentials');
    }
    seenNames.add(name);
    pairs.push({ name, value });
  }

  const psid = pairs.find((p) => p.name === '__Secure-1PSID')?.value;
  const psidts = pairs.find((p) => p.name === '__Secure-1PSIDTS')?.value;

  if (!psid || !psid.trim() || !psidts || !psidts.trim()) {
    throw new GeminiWebError('credentials');
  }

  const normalizedHeader = pairs.map((p) => `${p.name}=${p.value}`).join('; ');

  return {
    version: 1,
    revision,
    cookieHeader: normalizedHeader,
    authUser,
    updatedAt: now,
    models: [],
  };
}

export async function readCookieImport(
  path: string,
  authUser: number,
  signal?: AbortSignal,
): Promise<CookieCredential> {
  signal?.throwIfAborted();
  if (typeof path !== 'string' || !path.trim()) {
    throw new GeminiWebError('credentials');
  }

  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    signal?.throwIfAborted();
    const stat = await file.stat();
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600
    ) {
      throw new GeminiWebError('credentials');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new GeminiWebError('credentials');
    }
    const buf = Buffer.alloc(MAX_HEADER_LENGTH + 1);
    const { bytesRead } = await file.read(buf, 0, MAX_HEADER_LENGTH + 1, 0);
    signal?.throwIfAborted();
    if (bytesRead > MAX_HEADER_LENGTH) {
      throw new GeminiWebError('credentials');
    }
    const content = buf.toString('utf8', 0, bytesRead);
    const revision = randomUUID();
    return parseCookieImport(content, authUser, Date.now(), revision);
  } catch (error) {
    if (error instanceof GeminiWebError) {
      throw error;
    }
    if (signal?.aborted) {
      throw error;
    }
    throw new GeminiWebError('credentials');
  } finally {
    await file?.close();
  }
}

async function validateManagedDirectory(dirPath: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(dirPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw error;
    }
    throw new GeminiWebError('storage');
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw new GeminiWebError('storage');
  }
}

async function ensureManagedDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  let stat;
  try {
    stat = await lstat(dirPath);
  } catch {
    throw new GeminiWebError('storage');
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw new GeminiWebError('storage');
  }
  if ((stat.mode & 0o777) !== 0o700) {
    try {
      await chmod(dirPath, 0o700);
      const afterStat = await lstat(dirPath);
      if ((afterStat.mode & 0o777) !== 0o700) {
        throw new GeminiWebError('storage');
      }
    } catch {
      throw new GeminiWebError('storage');
    }
  }
}

function validateStoredCredential(value: unknown): CookieCredential {
  if (typeof value !== 'object' || value === null) {
    throw new GeminiWebError('storage');
  }
  const cred = value as Partial<CookieCredential>;
  if (cred.version !== 1) {
    throw new GeminiWebError('storage');
  }
  if (typeof cred.revision !== 'string' || !cred.revision.trim()) {
    throw new GeminiWebError('storage');
  }
  if (typeof cred.cookieHeader !== 'string' || !cred.cookieHeader.trim()) {
    throw new GeminiWebError('storage');
  }
  if (typeof cred.authUser !== 'number' || !Number.isSafeInteger(cred.authUser) || cred.authUser < 0) {
    throw new GeminiWebError('storage');
  }
  if (typeof cred.updatedAt !== 'number' || !Number.isFinite(cred.updatedAt)) {
    throw new GeminiWebError('storage');
  }
  try {
    parseCookieImport(cred.cookieHeader, cred.authUser, cred.updatedAt, cred.revision);
  } catch {
    throw new GeminiWebError('storage');
  }
  if (cred.lastRotationAt !== undefined && (!Number.isFinite(cred.lastRotationAt) || typeof cred.lastRotationAt !== 'number')) {
    throw new GeminiWebError('storage');
  }
  if (cred.catalogCheckedAt !== undefined && (!Number.isFinite(cred.catalogCheckedAt) || typeof cred.catalogCheckedAt !== 'number')) {
    throw new GeminiWebError('storage');
  }
  if (!Array.isArray(cred.models) || cred.models.length > MAX_MODELS_COUNT) {
    throw new GeminiWebError('storage');
  }
  for (const m of cred.models) {
    if (typeof m !== 'object' || m === null) {
      throw new GeminiWebError('storage');
    }
    if (typeof m.id !== 'string' || !m.id || m.id.length > 1024) {
      throw new GeminiWebError('storage');
    }
    if (typeof m.name !== 'string' || !m.name || m.name.length > 1024) {
      throw new GeminiWebError('storage');
    }
    if (typeof m.capacity !== 'number' || !Number.isFinite(m.capacity) || m.capacity <= 0) {
      throw new GeminiWebError('storage');
    }
    if (m.capacityField !== 12 && m.capacityField !== 13) {
      throw new GeminiWebError('storage');
    }
    if (typeof m.modelNumber !== 'number' || !Number.isSafeInteger(m.modelNumber) || m.modelNumber <= 0) {
      throw new GeminiWebError('storage');
    }
  }

  return cred as CookieCredential;
}

export class CookieCredentialStore {
  readonly path: string;
  private readonly lockWaitMs: number;

  constructor(path: string, lockWaitMs = 35_000) {
    this.path = path;
    this.lockWaitMs = lockWaitMs;
  }

  async read(signal?: AbortSignal): Promise<CookieCredential | undefined> {
    signal?.throwIfAborted();
    const dir = dirname(this.path);
    try {
      await validateManagedDirectory(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }

    let file;
    try {
      file = await open(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      signal?.throwIfAborted();
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
        throw new GeminiWebError('storage');
      }
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new GeminiWebError('storage');
      }
      const buf = Buffer.alloc(MAX_STORE_LENGTH + 1);
      const { bytesRead } = await file.read(buf, 0, MAX_STORE_LENGTH + 1, 0);
      signal?.throwIfAborted();
      if (bytesRead > MAX_STORE_LENGTH) {
        throw new GeminiWebError('storage');
      }
      const content = buf.toString('utf8', 0, bytesRead);
      return validateStoredCredential(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      if (error instanceof GeminiWebError) {
        throw error;
      }
      if (signal?.aborted) {
        throw error;
      }
      throw new GeminiWebError('storage');
    } finally {
      await file?.close();
    }
  }

  async save(data: CookieCredential): Promise<void> {
    validateStoredCredential(data);
    const dir = dirname(this.path);
    await ensureManagedDirectory(dir);

    try {
      const stat = await lstat(this.path);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      ) {
        throw new GeminiWebError('storage');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new GeminiWebError('storage');
      }
    }

    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      try {
        const directory = await open(dir, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {
        // Directory sync is best-effort across platforms
      }
    } catch (error) {
      if (error instanceof GeminiWebError) {
        throw error;
      }
      throw new GeminiWebError('storage');
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async update(
    fn: (
      current: CookieCredential | undefined,
    ) => Promise<CookieCredential | undefined> | CookieCredential | undefined,
    signal?: AbortSignal,
  ): Promise<CookieCredential | undefined> {
    signal?.throwIfAborted();
    const dir = dirname(this.path);
    await ensureManagedDirectory(dir);
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + this.lockWaitMs;

    // ponytail: one cross-process lock includes refresh I/O; per-account locks
    // only if measured contention matters. Never steal a possibly-live lock.
    // Abandoned lock directories from crashes must be cleaned up manually.
    while (true) {
      signal?.throwIfAborted();
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new GeminiWebError('storage');
        }
        if (Date.now() >= deadline) {
          throw new GeminiWebError('storage');
        }
        await sleep(25, undefined, { signal });
      }
    }

    try {
      signal?.throwIfAborted();
      const current = await this.read(signal);
      const next = await fn(current);
      if (next === undefined) {
        await rm(this.path, { force: true });
      } else {
        await this.save(next);
      }
      return next;
    } catch (error) {
      if (error instanceof GeminiWebError) {
        throw error;
      }
      if (signal?.aborted) {
        throw error;
      }
      throw new GeminiWebError('storage');
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}
