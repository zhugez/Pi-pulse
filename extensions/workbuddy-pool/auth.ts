import { wbFetch } from "./nodefetch.ts";
import type { FetchFunction, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { loginHeaders, refreshHeaders, url } from "./headers.ts";
import type { AccountStore, Realm, WbAccount } from "./store.ts";

const REFRESH_SKEW_SECONDS = 300;
const LOGIN_POLL_MS = 3_000;
const LOGIN_TIMEOUT_MS = 300_000;
const refreshFlights = new Map<string, Promise<RefreshResult | null>>();
type TokenBundle = { accessToken?: string; refreshToken?: string; expiresIn?: number; domain?: string };

interface Envelope<T> {
  code?: number | string;
  msg?: string;
  data?: T;
  [key: string]: unknown;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function needsRefresh(account: WbAccount): boolean {
  return account.expiresAt > 0 && account.expiresAt - nowSeconds() < REFRESH_SKEW_SECONDS;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  domain?: string;
}

/**
 * Upstream refresh rotates both tokens. Returns null when the account must log in
 * again (no refresh token or upstream rejected it).
 */
export async function refreshAccount(account: WbAccount, signal?: AbortSignal, fetchImpl: FetchFunction = wbFetch()): Promise<RefreshResult | null> {
  if (!account.refreshToken.trim()) return null;
  const existing = refreshFlights.get(account.uid);
  if (existing) return existing;
  const flight = refreshAccountOnce(account, signal, fetchImpl);
  refreshFlights.set(account.uid, flight);
  try {
    return await flight;
  } finally {
    if (refreshFlights.get(account.uid) === flight) refreshFlights.delete(account.uid);
  }
}

async function refreshAccountOnce(account: WbAccount, signal: AbortSignal | undefined, fetchImpl: FetchFunction): Promise<RefreshResult | null> {
  const response = await fetchImpl(url("/v2/plugin/auth/token/refresh", account), {
    method: "POST",
    headers: refreshHeaders(account),
    signal,
  });
  const text = await response.text();
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`WorkBuddy refresh failed: HTTP ${response.status}`);
  let payload: { accessToken?: string; refreshToken?: string; expiresIn?: number; domain?: string };
  try {
    const envelope = JSON.parse(text) as Envelope<typeof payload>;
    if (envelope.code !== undefined && Number(envelope.code) !== 0) {
      throw new Error("WorkBuddy refresh rejected by upstream");
    }
    payload = (envelope.data ?? envelope) as typeof payload;
  } catch {
    throw new Error("WorkBuddy refresh returned an invalid response");
  }
  if (!payload.accessToken) throw new Error("WorkBuddy refresh returned no access token");
  const expiresIn = Number(payload.expiresIn);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 && expiresIn < 315_360_000
    ? nowSeconds() + expiresIn
    : account.expiresAt;
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken || account.refreshToken,
    expiresAt,
    domain: payload.domain || account.domain,
  };
}

/** Refresh when the token is close to expiry and persist the rotated tokens. */
export async function ensureFreshAccount(store: AccountStore, account: WbAccount, signal?: AbortSignal): Promise<WbAccount> {
  if (!needsRefresh(account)) return account;
  const refreshed = await refreshAccount(account, signal);
  if (!refreshed) {
    await store.update((data) => {
      const current = data.accounts.find((a) => a.uid === account.uid);
      if (current && current.accessToken === account.accessToken) current.needsLogin = true;
    });
    return account;
  }
  await store.update((data) => {
    const current = data.accounts.find((a) => a.uid === account.uid);
    if (!current || current.accessToken !== account.accessToken) return;
    current.accessToken = refreshed.accessToken;
    current.refreshToken = refreshed.refreshToken;
    current.expiresAt = refreshed.expiresAt;
    if (refreshed.domain) current.domain = refreshed.domain;
    current.needsLogin = false;
  });
  return { ...account, ...refreshed, needsLogin: false };
}

function realmFromDomain(domain: string | undefined, fallback: Realm): Realm {
  if (!domain) return fallback;
  return domain.includes("workbuddy.ai") ? "global" : "cn";
}

/**
 * Browser login: ask upstream for an auth URL, let the user sign in, then poll the
 * token endpoint until it returns a token bundle. Mirrors the panel's login flow
 * (`/v2/plugin/auth/state` → `/v2/plugin/auth/token`).
 */
export async function loginWorkBuddy(interaction: ProviderAuthInteraction, fetchImpl: FetchFunction = wbFetch()): Promise<WbAccount> {
  const stateResponse = await fetchImpl(url("/v2/plugin/auth/state?platform=CLI"), {
    method: "POST",
    headers: loginHeaders(),
    body: "{}",
    signal: interaction.signal,
  });
  const stateText = await stateResponse.text();
  if (!stateResponse.ok) throw new Error(`WorkBuddy login failed: HTTP ${stateResponse.status} ${stateText.slice(0, 200)}`);
  const statePayload = JSON.parse(stateText) as Envelope<{ state?: string; authUrl?: string }>;
  const state = statePayload.data?.state ?? (statePayload.state as string | undefined);
  const authUrl = statePayload.data?.authUrl ?? (statePayload.authUrl as string | undefined);
  if (!state || !authUrl) throw new Error("WorkBuddy login failed: upstream returned no state/authUrl");

  interaction.notify({ type: "auth_url", url: authUrl, instructions: "Sign in to WorkBuddy, then return here." });

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (interaction.signal?.aborted) throw new Error("WorkBuddy login cancelled");
    await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS));
    const tokenResponse = await fetchImpl(url(`/v2/plugin/auth/token?state=${encodeURIComponent(state)}`), {
      headers: loginHeaders(),
      signal: interaction.signal,
    });
    if (tokenResponse.status >= 500) {
      await tokenResponse.body?.cancel();
      continue;
    }
    const tokenText = await tokenResponse.text();
    let tokenPayload: TokenBundle | null = null;
    try {
      const envelope = JSON.parse(tokenText) as Envelope<TokenBundle>;
      if (envelope.code !== undefined && Number(envelope.code) !== 0) continue;
      tokenPayload = (envelope.data ?? envelope) as TokenBundle;
    } catch {
      tokenPayload = null;
    }
    if (!tokenResponse.ok || !tokenPayload?.accessToken) continue;

    const accessToken = tokenPayload.accessToken;
    let uid = "";
    let nickname: string | undefined;
    try {
      const accountResponse = await fetchImpl(url(`/v2/plugin/login/account?state=${encodeURIComponent(state)}`), {
        headers: { ...loginHeaders(), Authorization: `Bearer ${accessToken}` },
        signal: interaction.signal,
      });
      if (accountResponse.ok) {
        const accountPayload = JSON.parse(await accountResponse.text()) as Envelope<{ uid?: string; nickname?: string }>;
        const data = (accountPayload.data ?? accountPayload) as { uid?: string; nickname?: string };
        uid = data.uid ?? "";
        nickname = data.nickname;
      }
    } catch {
      /* account lookup is best-effort; uid can be recovered from the token later */
    }
    if (!uid) throw new Error("WorkBuddy login succeeded but the account uid could not be resolved");

    const expiresIn = Number(tokenPayload.expiresIn);
    return {
      uid,
      nickname,
      realm: realmFromDomain(tokenPayload.domain, "global"),
      domain: tokenPayload.domain,
      accessToken,
      refreshToken: tokenPayload.refreshToken ?? "",
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? nowSeconds() + expiresIn : 0,
    };
  }
  throw new Error("WorkBuddy login timed out waiting for the browser sign-in");
}
