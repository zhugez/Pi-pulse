import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lockSync } from "proper-lockfile";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultProjectId } from "../client/client.js";
import { LEGACY_PROVIDER_ID, PROVIDER_ID } from "../models/models.js";
import type { AntigravityApiKey, AntigravityOAuthCredentials } from "../types/types.js";
import { refreshAntigravityToken } from "./oauth.js";

const ACCOUNTS_FILE = "antigravity-accounts.json";
const AUTH_FILE = "auth.json";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type StoredAccount = AntigravityOAuthCredentials & {
  accountId: string;
  addedAt: number;
  lastUsedAt: number;
  cooldownUntil?: number;
  supportedModels?: string[];
  unsupportedModels?: string[];
};

type AccountsFile = {
  version: 1;
  activeAccountId?: string;
  rotate?: boolean;
  accounts: Record<string, StoredAccount>;
};

export type AccountSummary = {
  accountId: string;
  email?: string;
  active: boolean;
  lastUsedAt: number;
  cooldown?: boolean;
};

export function normalizeModelFamily(modelId: string): string {
  const lower = modelId.trim().toLowerCase();
  if (lower === "gemini-3-flash-agent") return "gemini-3.5-flash";
  if (lower === "gemini-pro-agent") return "gemini-3.1-pro";
  return lower.replace(
    /-(?:extra-low|extra-high|minimal|low|medium|high|thinking|tiered|disabled)$/i,
    "",
  );
}

function accountsPath(): string {
  return join(getAgentDir(), ACCOUNTS_FILE);
}

function authPath(): string {
  return join(getAgentDir(), AUTH_FILE);
}

function readJsonObject(path: string, allowEmpty = false): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (allowEmpty && raw === "") return {};
  const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

function writePrivateJson(...files: [path: string, value: unknown][]): void {
  const staged: { dir: string; temp: string; path: string }[] = [];
  try {
    for (const [path, value] of files) {
      const dir = mkdtempSync(join(dirname(path), ".antigravity-"));
      const temp = join(dir, "state.json");
      staged.push({ dir, temp, path });
      writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    for (const { temp, path } of staged) renameSync(temp, path);
  } finally {
    for (const { dir } of staged) rmSync(dir, { recursive: true, force: true });
  }
}

function emptyStore(): AccountsFile {
  return { version: 1, accounts: {} };
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<StoredAccount>;
  return typeof account.refresh === "string" && account.refresh.length > 0;
}

function normalizeStore(value: Record<string, unknown> | undefined): AccountsFile {
  if (!value || value.version !== 1 || !value.accounts || typeof value.accounts !== "object") {
    return emptyStore();
  }
  const accounts: Record<string, StoredAccount> = {};
  for (const [key, raw] of Object.entries(value.accounts as Record<string, unknown>)) {
    if (!isStoredAccount(raw)) continue;
    const accountId =
      typeof raw.accountId === "string" && raw.accountId.trim() ? raw.accountId : key;
    accounts[accountId] = { ...raw, accountId };
  }
  const activeAccountId =
    typeof value.activeAccountId === "string"
      ? value.activeAccountId
      : typeof value.activeEmail === "string"
        ? value.activeEmail
        : undefined;
  const rotate = typeof value.rotate === "boolean" ? value.rotate : true;
  return {
    version: 1,
    activeAccountId: activeAccountId && accounts[activeAccountId] ? activeAccountId : undefined,
    rotate,
    accounts,
  };
}

export function loadAccountStore(): AccountsFile {
  try {
    return normalizeStore(readJsonObject(accountsPath()));
  } catch {
    return emptyStore();
  }
}

function withLockedAccounts<T>(path: string, use: (store: AccountsFile, target: string) => T): T {
  return withFileLock(path, (target) => use(normalizeStore(readJsonObject(target)), target));
}

function updateAccounts(update: (store: AccountsFile) => boolean | undefined): void {
  withLockedAccounts(accountsPath(), (store, target) => {
    if (update(store)) writePrivateJson([target, store]);
  });
}

function accountIdFor(credentials: OAuthCredentials): string {
  const email = (credentials as AntigravityOAuthCredentials).email?.trim().toLowerCase();
  if (email) return email;
  return `account-${createHash("sha256").update(credentials.refresh).digest("hex").slice(0, 16)}`;
}

function accountFromCredentials(
  credentials: AntigravityOAuthCredentials,
  existing?: StoredAccount,
  preserveLastUsedAt = false,
): StoredAccount {
  const now = Date.now();
  const useExistingToken =
    existing &&
    existing.access &&
    typeof existing.expires === "number" &&
    existing.expires > (credentials.expires || 0);
  return {
    ...credentials,
    access: useExistingToken ? existing.access : credentials.access,
    expires: useExistingToken ? existing.expires : credentials.expires,
    projectId: credentials.projectId || existing?.projectId,
    email: credentials.email || existing?.email,
    accountId: existing?.accountId || accountIdFor(credentials),
    addedAt: existing?.addedAt || now,
    lastUsedAt: preserveLastUsedAt && existing ? existing.lastUsedAt : now,
    cooldownUntil: existing?.cooldownUntil,
    supportedModels: existing?.supportedModels,
    unsupportedModels: existing?.unsupportedModels,
  };
}

function sortedAccounts(store: AccountsFile): StoredAccount[] {
  return Object.values(store.accounts).sort((a, b) => {
    if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
    return a.accountId.localeCompare(b.accountId);
  });
}

function findAccount(
  store: AccountsFile,
  credentials: OAuthCredentials,
): StoredAccount | undefined {
  const email = (credentials as AntigravityOAuthCredentials).email?.trim().toLowerCase();
  return Object.values(store.accounts).find(
    (account) =>
      account.refresh === credentials.refresh ||
      (email !== undefined && account.email?.trim().toLowerCase() === email),
  );
}

function findAccountId(store: AccountsFile, selector: string): string | undefined {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) return undefined;
  const entries = sortedAccounts(store);
  if (/^\d+$/.test(normalized)) {
    const index = Number.parseInt(normalized, 10);
    if (index >= 1 && index <= entries.length) return entries[index - 1]?.accountId;
    return undefined;
  }
  return entries.find(
    (account) =>
      account.accountId.toLowerCase() === normalized ||
      account.email?.trim().toLowerCase() === normalized,
  )?.accountId;
}

function withFileLock<T>(path: string, use: (target: string) => T): T {
  let target: string;
  try {
    target = realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || lstatSync(path, { throwIfNoEntry: false })) throw error;
    target = join(realpathSync(dirname(path)), basename(path));
  }
  const unlock = lockSync(target, { realpath: false, stale: 30_000, update: 15_000 });
  try {
    return use(target);
  } finally {
    unlock();
  }
}

function withLockedAuth<T>(path: string, use: (auth: Record<string, unknown>, target: string) => T): T {
  return withFileLock(path, (target) => {
    let auth: Record<string, unknown>;
    try {
      auth = readJsonObject(target, true) ?? {};
    } catch {
      throw new Error("Refusing to overwrite unreadable Pi auth.json");
    }
    return use(auth, target);
  });
}

export function migrateLegacyAntigravityAuth(): "migrated" | "collision" | "absent" | "invalid" {
  return withLockedAuth(authPath(), (auth, target) => {
    if (!Object.hasOwn(auth, LEGACY_PROVIDER_ID)) return "absent";
    if (Object.hasOwn(auth, PROVIDER_ID)) return "collision";
    const legacy = auth[LEGACY_PROVIDER_ID] as Partial<AntigravityOAuthCredentials & { type: string }> | undefined;
    if (
      legacy?.type !== 'oauth' ||
      typeof legacy.refresh !== 'string' ||
      !legacy.refresh.trim() ||
      typeof legacy.access !== 'string' ||
      typeof legacy.expires !== 'number' ||
      !Number.isFinite(legacy.expires)
    )
      return 'invalid';
    auth[PROVIDER_ID] = legacy;
    delete auth[LEGACY_PROVIDER_ID];
    writePrivateJson([target, auth]);
    return "migrated";
  });
}

function importCurrentAuth(store: AccountsFile, current: unknown): string | undefined {
  if (!current || typeof current !== "object") return undefined;
  const record = current as Record<string, unknown>;
  if (typeof record.refresh !== "string" || !record.refresh) return undefined;
  const credentials = {
    access: typeof record.access === "string" ? record.access : "",
    refresh: record.refresh,
    expires: typeof record.expires === "number" ? record.expires : 0,
    projectId: typeof record.projectId === "string" ? record.projectId : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
  };
  const existing = findAccount(store, credentials);
  const account = existing && existing.expires > credentials.expires
    ? existing
    : accountFromCredentials(credentials, existing, true);
  store.accounts[account.accountId] = account;
  if (!store.activeAccountId || !store.accounts[store.activeAccountId]) {
    store.activeAccountId = account.accountId;
  }
  return account.accountId;
}

function importCanonicalAuth(store: AccountsFile): string | undefined {
  let current: unknown;
  try {
    current = readJsonObject(authPath(), true)?.[PROVIDER_ID];
  } catch {
    return undefined;
  }
  return importCurrentAuth(store, current);
}

export function syncCurrentAuth(): void {
  updateAccounts((store) => Boolean(importCanonicalAuth(store)));
}

export function rememberAccount(credentials: AntigravityOAuthCredentials): void {
  updateAccounts((store) => {
    importCanonicalAuth(store);
    const account = accountFromCredentials(credentials, findAccount(store, credentials));
    store.accounts[account.accountId] = account;
    store.activeAccountId = account.accountId;
    return true;
  });
}

export async function refreshRememberedAccount(credentials: OAuthCredentials): Promise<AntigravityOAuthCredentials> {
  const linked = findAccount(loadAccountStore(), credentials);
  const refreshed = await refreshAntigravityToken(linked ?? credentials);
  if (linked && !commitRefreshedAccount(linked, refreshed, false)) {
    throw new Error("Antigravity linked credentials changed during refresh. Retry the request.");
  }
  return refreshed;
}

export function listAccounts(): AccountSummary[] {
  syncCurrentAuth();
  const store = loadAccountStore();
  const now = Date.now();
  return sortedAccounts(store).map((account) => ({
    accountId: account.accountId,
    email: account.email,
    active: account.accountId === store.activeAccountId,
    lastUsedAt: account.lastUsedAt,
    cooldown: Boolean(account.cooldownUntil && account.cooldownUntil > now),
  }));
}

async function ensureFresh(account: StoredAccount): Promise<StoredAccount> {
  if (account.access && account.expires > Date.now() + REFRESH_SKEW_MS) return account;
  const refreshed = await refreshAntigravityToken(account);
  return {
    ...accountFromCredentials(refreshed, account),
    lastUsedAt: account.lastUsedAt,
  };
}

function apiKeyFor(account: StoredAccount): AntigravityApiKey {
  const email = account.email?.trim();
  return {
    token: account.access,
    projectId: account.projectId || defaultProjectId(email || "antigravity-default"),
  };
}

function credentialFields({ email, access, refresh, expires, projectId }: AntigravityOAuthCredentials) {
  return { email, access, refresh, expires, projectId };
}

function commitRefreshedAccount(
  previous: StoredAccount,
  refreshed: AntigravityOAuthCredentials,
  used: boolean,
): StoredAccount | undefined {
  let result: StoredAccount | undefined;
  updateAccounts((store) => {
    const current = store.accounts[previous.accountId];
    if (
      !current ||
      current.addedAt !== previous.addedAt ||
      !isDeepStrictEqual(credentialFields(current), credentialFields(previous))
    )
      return;
    const fields = credentialFields(refreshed);
    result = { ...current, ...fields, lastUsedAt: used ? Date.now() : current.lastUsedAt };
    if (!used && isDeepStrictEqual(fields, credentialFields(current))) return false;
    store.accounts[current.accountId] = result;
    return true;
  });
  return result;
}

async function changeAccountSelection(selector: string, action: "switch" | "remove") {
  const authFile = authPath();
  const linkedFile = accountsPath();
  function readSelection(store: AccountsFile, auth: Record<string, unknown>, target: string) {
    const { activeAccountId, rotate } = store;
    const linked = { ...store.accounts };
    const canonical = auth[PROVIDER_ID];
    const canonicalId = importCurrentAuth(store, canonical);
    const accountId = findAccountId(store, selector);
    if (!accountId) return undefined;
    const removingActive = store.activeAccountId === accountId;
    const changesAuth = action === "switch" || removingActive || canonicalId === accountId;
    const selectsAccount = action === "switch" || removingActive;
    const next =
      action === 'switch'
        ? store.accounts[accountId]
        : removingActive
          ? sortedAccounts(store)
              .filter((a) => a.accountId !== accountId)
              .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
          : changesAuth && store.activeAccountId
            ? store.accounts[store.activeAccountId]
            : undefined;
    const ids = new Set([accountId, next?.accountId]);
    const credentials = [...ids].map((id) =>
      id && linked[id] ? [linked[id].addedAt, credentialFields(linked[id])] : undefined,
    );
    const version = [
      target,
      canonical,
      activeAccountId,
      rotate,
      accountId,
      canonicalId,
      changesAuth,
      next?.accountId,
      credentials,
    ];
    return { accountId, next, selectsAccount, changesAuth, version };
  }

  const before = withLockedAuth(authFile, (auth, target) =>
    withLockedAccounts(linkedFile, (store) => readSelection(store, auth, target)));
  if (!before) throw new Error(`Antigravity account not found: ${selector}`);
  const fresh = before.selectsAccount && before.next ? await ensureFresh(before.next) : undefined;
  return withLockedAuth(authFile, (auth, target) => withLockedAccounts(linkedFile, (store, linkedTarget) => {
    const current = readSelection(store, auth, target);
    if (!current || !isDeepStrictEqual(current.version, before.version)) {
      throw new Error("Antigravity account selection changed. Retry the command.");
    }
    const { accountId, next, selectsAccount, changesAuth } = current;
    if (action === "remove") delete store.accounts[accountId];
    else store.rotate = false;
    const account = fresh && next ? { ...next, ...credentialFields(fresh), lastUsedAt: Date.now() } : next;
    if (selectsAccount) {
      if (account) store.accounts[account.accountId] = account;
      store.activeAccountId = account?.accountId;
    }
    if (changesAuth) {
      if (account) auth[PROVIDER_ID] = { type: "oauth", ...credentialFields(account) };
      else delete auth[PROVIDER_ID];
      writePrivateJson([target, auth], [linkedTarget, store]);
    } else {
      writePrivateJson([linkedTarget, store]);
    }
    return selectsAccount ? account : undefined;
  }));
}

export async function activateAccount(selector: string): Promise<StoredAccount> {
  return (await changeAccountSelection(selector, "switch"))!;
}

export function removeAccount(selector: string): Promise<StoredAccount | undefined> {
  return changeAccountSelection(selector, "remove");
}

function findAccountByTokenOrId(
  store: AccountsFile,
  tokenOrAccountId: string,
): StoredAccount | undefined {
  return Object.values(store.accounts).find(
    (acc) =>
      acc.access === tokenOrAccountId ||
      acc.accountId === tokenOrAccountId ||
      acc.email === tokenOrAccountId,
  );
}

export function markAccountCooldown(tokenOrAccountId: string, durationMs = 60_000): void {
  updateAccounts((store) => {
    const account = findAccountByTokenOrId(store, tokenOrAccountId);
    if (!account) return;
    account.cooldownUntil = Date.now() + Math.max(durationMs, 5_000);
    return true;
  });
}

export function markAccountModelUnsupported(tokenOrAccountId: string, modelId: string): void {
  if (!modelId) return;
  updateAccounts((store) => {
    const account = findAccountByTokenOrId(store, tokenOrAccountId);
    if (!account) return;
    const family = normalizeModelFamily(modelId);
    const unsupported = new Set(account.unsupportedModels ?? []);
    unsupported.add(family);
    account.unsupportedModels = [...unsupported].sort();
    if (account.supportedModels) {
      account.supportedModels = account.supportedModels.filter((m) => m !== family && m !== modelId);
    }
    return true;
  });
}

export function recordAccountModelCatalog(
  tokenOrAccountId: string,
  rawModels:
    | Record<string, { isInternal?: unknown; disabled?: unknown; [key: string]: unknown }>
    | undefined,
): void {
  if (!rawModels) return;
  updateAccounts((store) => {
    const account = findAccountByTokenOrId(store, tokenOrAccountId);
    if (!account) return;

    const supported = new Set<string>();
    const disabled = new Set<string>(account.unsupportedModels ?? []);

    for (const [runtimeId, info] of Object.entries(rawModels)) {
      if (!/^(gemini-|claude-|gpt-oss-)/i.test(runtimeId) || /\s/.test(runtimeId)) continue;
      if (/^(chat_|tab_)/i.test(runtimeId) || /image/i.test(runtimeId)) continue;
      if (info?.isInternal) continue;
      const family = normalizeModelFamily(runtimeId);
      if (/-disabled$/i.test(runtimeId) || info?.disabled === true) {
        disabled.add(family);
      } else {
        supported.add(family);
      }
    }

    for (const model of supported) disabled.delete(model);
    if (supported.size > 0) account.supportedModels = [...supported].sort();
    account.unsupportedModels = disabled.size > 0 ? [...disabled].sort() : undefined;
    return true;
  });
}

export async function listAccountApiKeys(): Promise<AntigravityApiKey[]> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accounts = sortedAccounts(store);
  if (accounts.length === 0) return [];
  const keys: AntigravityApiKey[] = [];
  for (const candidate of accounts) {
    try {
      const account = commitRefreshedAccount(candidate, await ensureFresh(candidate), false);
      if (account?.access) keys.push(apiKeyFor(account));
    } catch {
      // Ignore accounts whose refresh token fails during catalog discovery
    }
  }
  return keys;
}

export function setAccountRotation(enabled?: boolean): boolean {
  return withLockedAccounts(accountsPath(), (store, target) => {
    store.rotate = enabled ?? store.rotate === false;
    writePrivateJson([target, store]);
    return store.rotate;
  });
}

export function isAccountRotationEnabled(): boolean {
  const store = loadAccountStore();
  return store.rotate !== false;
}

function isModelExplicitlyUnsupported(account: StoredAccount, modelId: string | undefined): boolean {
  if (!modelId || !account.unsupportedModels?.length) return false;
  const family = normalizeModelFamily(modelId);
  const raw = modelId.trim().toLowerCase();
  return account.unsupportedModels.some((m) => m === family || m === raw);
}

function isAccountEligibleForModel(
  account: StoredAccount,
  modelId: string | undefined,
  allAccounts: StoredAccount[],
): boolean {
  if (!modelId) return true;
  if (isModelExplicitlyUnsupported(account, modelId)) return false;
  const family = normalizeModelFamily(modelId);
  const raw = modelId.trim().toLowerCase();
  const anyAccountExplicitlySupports = allAccounts.some((acc) =>
    acc.supportedModels?.some((m) => m === family || m === raw),
  );
  if (
    anyAccountExplicitlySupports &&
    Array.isArray(account.supportedModels) &&
    account.supportedModels.length > 0 &&
    !account.supportedModels.some((m) => m === family || m === raw)
  ) {
    return false;
  }
  return true;
}

function accountModelPriority(account: StoredAccount, modelId: string | undefined): number {
  if (!modelId) return 0;
  const family = normalizeModelFamily(modelId);
  const raw = modelId.trim().toLowerCase();
  if (account.supportedModels?.some((m) => m === family || m === raw)) return 0;
  if (!account.supportedModels || account.supportedModels.length === 0) return 1;
  return 2;
}

/**
 * Proactively selects the next account to use before sending a request.
 * Rotates through available accounts using least-recently-used selection
 * while skipping accounts that are currently on cooldown or lack the requested model.
 */
export async function acquireNextAccount(modelId?: string): Promise<AntigravityApiKey | undefined> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accounts = Object.values(store.accounts);
  if (accounts.length === 0) return undefined;

  // If rotation is explicitly disabled, stick to the active account unless it is known
  // not to support the requested model while another linked account does.
  if (store.rotate === false) {
    const active =
      (store.activeAccountId && store.accounts[store.activeAccountId]) || accounts[0];
    if (active && isAccountEligibleForModel(active, modelId, accounts)) {
      try {
        const account = commitRefreshedAccount(active, await ensureFresh(active), true);
        return account ? apiKeyFor(account) : undefined;
      } catch {
        return undefined;
      }
    }
  }

  const now = Date.now();
  const eligible = accounts.filter((acc) => isAccountEligibleForModel(acc, modelId, accounts));
  const pool = eligible.length > 0 ? eligible : accounts;

  // Prioritize model support, then non-cooldown accounts, then least-recently-used
  const candidates = [...pool].sort((a, b) => {
    const aPrio = accountModelPriority(a, modelId);
    const bPrio = accountModelPriority(b, modelId);
    if (aPrio !== bPrio) return aPrio - bPrio;
    const aCool = (a.cooldownUntil ?? 0) > now;
    const bCool = (b.cooldownUntil ?? 0) > now;
    if (aCool !== bCool) return aCool ? 1 : -1;
    return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
  });

  for (const candidate of candidates) {
    try {
      const fresh = await ensureFresh(candidate);
      if (!fresh.access) continue;
      const account = commitRefreshedAccount(candidate, fresh, true);
      if (account) return apiKeyFor(account);
    } catch {
      // Skip account if token refresh fails
    }
  }
  return undefined;
}

/**
 * Switch to the next stored account that has not already been tried in this request.
 * Used when Antigravity returns a hard quota wall (HTTP 429) or model unavailable (HTTP 404).
 */
export async function failoverToNextAccount(
  triedAccessTokens: ReadonlySet<string>,
  modelId?: string,
): Promise<AntigravityApiKey | undefined> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const now = Date.now();
  const allAccounts = Object.values(store.accounts);
  const untried = allAccounts.filter(
    (account) =>
      !triedAccessTokens.has(account.access) && !isModelExplicitlyUnsupported(account, modelId),
  );
  const eligible = untried.filter((acc) => isAccountEligibleForModel(acc, modelId, allAccounts));
  const pool = eligible.length > 0 ? eligible : untried;

  const candidates = [...pool].sort((a, b) => {
    const aPrio = accountModelPriority(a, modelId);
    const bPrio = accountModelPriority(b, modelId);
    if (aPrio !== bPrio) return aPrio - bPrio;
    const aCool = (a.cooldownUntil ?? 0) > now;
    const bCool = (b.cooldownUntil ?? 0) > now;
    if (aCool !== bCool) return aCool ? 1 : -1;
    return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
  });

  for (const candidate of candidates) {
    try {
      const fresh = await ensureFresh(candidate);
      if (!fresh.access || triedAccessTokens.has(fresh.access)) continue;
      const account = commitRefreshedAccount(candidate, fresh, true);
      if (account) return apiKeyFor(account);
    } catch {
      // Skip accounts whose refresh token is no longer valid.
    }
  }
  return undefined;
}
