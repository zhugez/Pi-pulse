import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { defaultProjectId } from "../client/client.js";
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

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function accountsPath(): string {
  return join(agentDir(), ACCOUNTS_FILE);
}

function authPath(): string {
  return join(agentDir(), AUTH_FILE);
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function writePrivateJson(path: string, value: unknown): void {
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
  chmodSync(path, 0o600);
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
  return normalizeStore(readJsonObject(accountsPath()));
}

function saveAccountStore(store: AccountsFile): void {
  writePrivateJson(accountsPath(), store);
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

function readAuthFile(): Record<string, unknown> {
  const path = authPath();
  if (!existsSync(path)) return {};
  const parsed = readJsonObject(path);
  if (!parsed) {
    throw new Error("Refusing to overwrite unreadable Pi auth.json");
  }
  return parsed;
}

function writeActiveCredential(account: StoredAccount | undefined): void {
  const auth = readAuthFile();
  if (account) {
    auth.antigravity = {
      type: "oauth",
      email: account.email,
      access: account.access,
      refresh: account.refresh,
      expires: account.expires,
      projectId: account.projectId,
    };
  } else {
    delete auth.antigravity;
  }
  writePrivateJson(authPath(), auth);
}

function currentAuthCredentials(): AntigravityOAuthCredentials | undefined {
  const current = readJsonObject(authPath())?.antigravity;
  if (!current || typeof current !== "object") return undefined;
  const record = current as Record<string, unknown>;
  if (typeof record.refresh !== "string" || !record.refresh) return undefined;
  return {
    access: typeof record.access === "string" ? record.access : "",
    refresh: record.refresh,
    expires: typeof record.expires === "number" ? record.expires : 0,
    projectId: typeof record.projectId === "string" ? record.projectId : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
  };
}

export function syncCurrentAuth(): void {
  const credentials = currentAuthCredentials();
  if (!credentials) return;
  const store = loadAccountStore();
  const existing = findAccount(store, credentials);
  const account = accountFromCredentials(credentials, existing, true);
  store.accounts[account.accountId] = account;
  if (!store.activeAccountId || !store.accounts[store.activeAccountId]) {
    store.activeAccountId = account.accountId;
  }
  saveAccountStore(store);
}

export function rememberAccount(credentials: AntigravityOAuthCredentials): StoredAccount {
  syncCurrentAuth();
  const store = loadAccountStore();
  const existing = findAccount(store, credentials);
  const account = accountFromCredentials(credentials, existing);
  store.accounts[account.accountId] = account;
  store.activeAccountId = account.accountId;
  saveAccountStore(store);
  return account;
}

export function updateRememberedAccount(
  previous: OAuthCredentials,
  credentials: AntigravityOAuthCredentials,
): void {
  const store = loadAccountStore();
  const existing = findAccount(store, previous);
  if (!existing) return;
  const account = accountFromCredentials(credentials, existing);
  delete store.accounts[existing.accountId];
  store.accounts[account.accountId] = account;
  if (store.activeAccountId === existing.accountId) {
    store.activeAccountId = account.accountId;
  }
  saveAccountStore(store);
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

export async function activateAccount(selector: string): Promise<StoredAccount> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accountId = findAccountId(store, selector);
  if (!accountId) throw new Error(`Antigravity account not found: ${selector}`);
  const existing = store.accounts[accountId];
  if (!existing) throw new Error(`Antigravity account not found: ${selector}`);
  const account = await ensureFresh(existing);
  account.lastUsedAt = Date.now();
  store.accounts[account.accountId] = account;
  store.activeAccountId = account.accountId;
  store.rotate = false;
  saveAccountStore(store);
  writeActiveCredential(account);
  return account;
}

export async function removeAccount(selector: string): Promise<StoredAccount | undefined> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accountId = findAccountId(store, selector);
  if (!accountId) throw new Error(`Antigravity account not found: ${selector}`);
  delete store.accounts[accountId];
  let next: StoredAccount | undefined;
  if (store.activeAccountId === accountId) {
    next = sortedAccounts(store).sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    if (next) {
      next = await ensureFresh(next);
      next.lastUsedAt = Date.now();
      store.accounts[next.accountId] = next;
    }
    store.activeAccountId = next?.accountId;
    writeActiveCredential(next);
  }
  saveAccountStore(store);
  return next;
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
  const store = loadAccountStore();
  const account = findAccountByTokenOrId(store, tokenOrAccountId);
  if (!account) return;
  account.cooldownUntil = Date.now() + Math.max(durationMs, 5_000);
  store.accounts[account.accountId] = account;
  saveAccountStore(store);
}

export function markAccountModelUnsupported(tokenOrAccountId: string, modelId: string): void {
  if (!modelId) return;
  const store = loadAccountStore();
  const account = findAccountByTokenOrId(store, tokenOrAccountId);
  if (!account) return;
  const family = normalizeModelFamily(modelId);
  const unsupported = new Set(account.unsupportedModels ?? []);
  unsupported.add(family);
  account.unsupportedModels = [...unsupported].sort();
  if (account.supportedModels) {
    account.supportedModels = account.supportedModels.filter((m) => m !== family && m !== modelId);
  }
  store.accounts[account.accountId] = account;
  saveAccountStore(store);
}

export function recordAccountModelCatalog(
  tokenOrAccountId: string,
  rawModels:
    | Record<string, { isInternal?: unknown; disabled?: unknown; [key: string]: unknown }>
    | undefined,
): void {
  if (!rawModels) return;
  const store = loadAccountStore();
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

  for (const model of supported) {
    disabled.delete(model);
  }

  if (supported.size > 0) {
    account.supportedModels = [...supported].sort();
  }
  account.unsupportedModels = disabled.size > 0 ? [...disabled].sort() : undefined;
  store.accounts[account.accountId] = account;
  saveAccountStore(store);
}

export async function listAccountApiKeys(): Promise<AntigravityApiKey[]> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accounts = sortedAccounts(store);
  if (accounts.length === 0) return [];
  const keys: AntigravityApiKey[] = [];
  let updated = false;
  for (const candidate of accounts) {
    try {
      const fresh = await ensureFresh(candidate);
      if (fresh.access !== candidate.access || fresh.expires !== candidate.expires) {
        store.accounts[fresh.accountId] = fresh;
        updated = true;
      }
      if (fresh.access) keys.push(apiKeyFor(fresh));
    } catch {
      // Ignore accounts whose refresh token fails during catalog discovery
    }
  }
  if (updated) saveAccountStore(store);
  return keys;
}

export function setAccountRotation(enabled: boolean): boolean {
  const store = loadAccountStore();
  store.rotate = enabled;
  saveAccountStore(store);
  return enabled;
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
        const fresh = await ensureFresh(active);
        fresh.lastUsedAt = Date.now();
        store.accounts[fresh.accountId] = fresh;
        saveAccountStore(store);
        return apiKeyFor(fresh);
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
      fresh.lastUsedAt = Date.now();
      store.accounts[fresh.accountId] = fresh;
      saveAccountStore(store);
      return apiKeyFor(fresh);
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
      const account = await ensureFresh(candidate);
      if (!account.access || triedAccessTokens.has(account.access)) continue;
      account.lastUsedAt = Date.now();
      store.accounts[account.accountId] = account;
      saveAccountStore(store);
      return apiKeyFor(account);
    } catch {
      // Skip accounts whose refresh token is no longer valid.
    }
  }
  return undefined;
}
