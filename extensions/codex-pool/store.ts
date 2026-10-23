import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OAuthCredential } from "@earendil-works/pi-ai";

export class PoolError extends Error {}
export interface Account {
  id: string;
  credential: OAuthCredential;
  cooldownUntil?: number;
  needsLogin?: boolean;
}
export interface PoolData {
  version: 1;
  preferred?: string;
  accounts: Account[];
}

// JWT claims are identity hints, not verification. Only SDK-issued OAuth tokens
// enter this store; the native Codex transport derives its own account header.
export function accountIdentity(credential: OAuthCredential): string {
  try {
    const claims = JSON.parse(Buffer.from(credential.access.split(".")[1], "base64url").toString());
    const account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof claims.sub !== "string" || !claims.sub || typeof account !== "string" || !account ||
        credential.accountId !== account) throw new Error();
    return createHash("sha256").update(`${account}\0${claims.sub}`).digest("hex");
  } catch {
    throw new PoolError("Codex login returned no stable account identity.");
  }
}

function validate(value: unknown): PoolData {
  const data = value as PoolData;
  if (data?.version !== 1 || !Array.isArray(data.accounts) ||
      (data.preferred !== undefined && typeof data.preferred !== "string")) throw new Error();
  const ids = new Set<string>();
  for (const account of data.accounts) {
    const c = account?.credential;
    if (!c || c.type !== "oauth" || typeof c.access !== "string" || !c.access ||
        typeof c.refresh !== "string" || !c.refresh || !Number.isFinite(c.expires) ||
        account.id !== accountIdentity(c) || ids.has(account.id) ||
        (account.needsLogin !== undefined && typeof account.needsLogin !== "boolean") ||
        (account.cooldownUntil !== undefined && !Number.isFinite(account.cooldownUntil))) throw new Error();
    ids.add(account.id);
  }
  if (data.preferred && !ids.has(data.preferred)) throw new Error();
  return data;
}

export class AccountStore {
  readonly path: string;
  private readonly lockWaitMs: number;

  constructor(path: string, lockWaitMs = 35_000) {
    this.path = path;
    this.lockWaitMs = lockWaitMs;
  }

  async read(signal?: AbortSignal): Promise<PoolData> {
    signal?.throwIfAborted();
    let file;
    try {
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) ||
          (process.getuid && stat.uid !== process.getuid())) throw new Error();
      return validate(JSON.parse(await file.readFile("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, accounts: [] };
      throw new PoolError("Cannot read private codex-accounts.json (expected valid, owner-only 0600 file).");
    } finally {
      await file?.close();
    }
  }

  async save(data: PoolData): Promise<void> {
    validate(data);
    try {
      const stat = await lstat(this.path);
      if (stat.isSymbolicLink() || !stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) ||
          (process.getuid && stat.uid !== process.getuid())) {
        throw new Error();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new PoolError("Cannot persist private Codex account store (target is invalid or insecure).");
      }
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      try {
        const directory = await open(dirname(this.path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch { /* directory sync is best-effort across platforms */ }
    } catch (error) {
      if (error instanceof PoolError) throw error;
      throw new PoolError("Cannot persist private Codex account store.");
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async update<T>(fn: (data: PoolData) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + this.lockWaitMs;
    // ponytail: one cross-process lock includes refresh I/O; per-account locks
    // only if measured contention matters. Never steal a possibly-live lock.
    // Abandoned lock directories from crashes must be cleaned up manually.
    while (true) {
      signal?.throwIfAborted();
      try { await mkdir(lock, { mode: 0o700 }); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new PoolError("Cannot lock Codex account store.");
        }
        if (Date.now() >= deadline) throw new PoolError("Codex account store is locked. See codex-pool README for crash recovery.");
        await sleep(25, undefined, { signal });
      }
    }
    try {
      signal?.throwIfAborted();
      const data = await this.read(signal);
      const result = await fn(data);
      // Persist a rotated refresh token even if the caller aborted meanwhile.
      await this.save(data);
      return result;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async add(credential: OAuthCredential, signal?: AbortSignal): Promise<string> {
    const id = accountIdentity(credential);
    return this.update((data) => {
      const index = data.accounts.findIndex((a) => a.id === id);
      const account = { id, credential };
      if (index < 0) data.accounts.push(account);
      else data.accounts[index] = account;
      data.preferred ??= id;
      return id;
    }, signal);
  }

  async manage(action: "switch" | "remove", prefix: string, signal?: AbortSignal): Promise<string> {
    return this.update((data) => {
      const matches = data.accounts.filter((a) => a.id.startsWith(prefix));
      if (!prefix || matches.length !== 1) throw new PoolError("Use one unambiguous account ID from /codex-pool.accounts list.");
      const id = matches[0].id;
      if (action === "switch") data.preferred = id;
      else {
        data.accounts = data.accounts.filter((a) => a.id !== id);
        if (data.preferred === id) data.preferred = data.accounts[0]?.id;
      }
      return id;
    }, signal);
  }
}
