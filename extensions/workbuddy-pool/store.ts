import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Realm = "global" | "cn";

export interface WbAccount {
  uid: string;
  nickname?: string;
  realm: Realm;
  domain?: string;
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
  deviceToken?: string;
  /** Remaining credit reported by the billing endpoint, for display/rotation. */
  credit?: number;
  cooldownUntil?: number;
  /** Model-specific 6004 rate-limit deadlines; other models remain usable. */
  modelCooldowns?: Record<string, number>;
  needsLogin?: boolean;
}

export interface WbStoreFile {
  version: 1;
  accounts: WbAccount[];
}

export function accountBase(account: WbAccount): string {
  return account.realm === "global" ? "https://www.workbuddy.ai" : "https://www.workbuddy.cn";
}

export function originFor(account: WbAccount): string {
  return account.realm === "global" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn";
}

export function accountLabel(account: WbAccount): string {
  return account.nickname || account.uid.slice(0, 8);
}

/**
 * Accounts live in one JSON file next to the other pi account stores.
 * Writes are serialized through a promise chain: two concurrent logins must not
 * clobber each other's account.
 */
export class AccountStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  path(): string {
    return this.file;
  }

  async read(): Promise<WbStoreFile> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as WbStoreFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) throw new Error("Invalid WorkBuddy account store");
      for (const account of parsed.accounts) {
        if (!account || typeof account.uid !== "string" || !account.uid ||
          typeof account.accessToken !== "string" || !account.accessToken ||
          typeof account.refreshToken !== "string" || !Number.isFinite(account.expiresAt) ||
          !["cn", "global"].includes(account.realm)) throw new Error("Invalid WorkBuddy account record");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: 1, accounts: [] };
    }
  }

  async update(fn: (data: WbStoreFile) => void | Promise<void>): Promise<WbStoreFile> {
    const run = async () => {
      const data = await this.read();
      await fn(data);
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
      return data;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async upsert(account: WbAccount): Promise<void> {
    await this.update((data) => {
      const index = data.accounts.findIndex((a) => a.uid === account.uid);
      if (index >= 0) data.accounts[index] = { ...data.accounts[index], ...account };
      else data.accounts.push(account);
    });
  }

  async remove(uid: string): Promise<boolean> {
    let removed = false;
    await this.update((data) => {
      const before = data.accounts.length;
      data.accounts = data.accounts.filter((a) => a.uid !== uid);
      removed = data.accounts.length !== before;
    });
    return removed;
  }
}

interface PanelAuthFile {
  account?: { uid?: string; nickname?: string; enterpriseId?: string };
  auth?: { accessToken?: string; refreshToken?: string; expiresAt?: string | number; domain?: string; realm?: string };
}

function expiresAtSeconds(value: string | number | undefined): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Import accounts already provisioned by the self-hosted workbuddy2api panel so
 * users do not have to re-login to switch over. Unknown/blank files are skipped.
 */
export async function importPanelAuths(dir: string): Promise<WbAccount[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const imported: WbAccount[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let parsed: PanelAuthFile;
    try {
      parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as PanelAuthFile;
    } catch {
      continue;
    }
    const uid = parsed.account?.uid;
    const accessToken = parsed.auth?.accessToken;
    if (!uid || !accessToken) continue;
    imported.push({
      uid,
      nickname: parsed.account?.nickname,
      realm: parsed.auth?.realm === "global" ? "global" : "cn",
      domain: parsed.auth?.domain,
      accessToken,
      refreshToken: parsed.auth?.refreshToken ?? "",
      expiresAt: expiresAtSeconds(parsed.auth?.expiresAt),
    });
  }
  return imported;
}
