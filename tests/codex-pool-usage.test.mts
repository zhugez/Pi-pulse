import assert from "node:assert/strict";
import test from "node:test";
import { AccountStore } from "../extensions/codex-pool/store.ts";
import { usageProviderCfgs, resolveRefreshTargets, MissingCredentialError } from "../extensions/subscription-usage.ts";

const cfg = () => {
  const found = usageProviderCfgs.find((provider) => provider.id === "codex-pool");
  assert.ok(found, "codex-pool must be available to /usage");
  return found;
};

test("codex-pool usage is registered and keeps account quotas separate", async (t) => {
  const provider = cfg();
  assert.deepEqual(resolveRefreshTargets("active", usageProviderCfgs, "codex-pool"), [provider]);
  t.mock.method(AccountStore.prototype, "read", async () => ({ version: 1, accounts: [
    { id: "aaaaaaaaaaaa", credential: { access: "token-a", accountId: "account-a", expires: Date.now() + 60000 } },
    { id: "bbbbbbbbbbbb", credential: { access: "token-b", accountId: "account-b", expires: Date.now() + 60000 } },
  ] }));
  const http = t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    const first = headers.get("ChatGPT-Account-Id") === "account-a";
    assert.equal(headers.get("Authorization"), first ? "Bearer token-a" : "Bearer token-b");
    return new Response(JSON.stringify({ rate_limit: { primary_window: {
      used_percent: first ? 20 : 80, limit_window_seconds: 18000, reset_at: 1900000000,
    } } }));
  });
  const data = await provider.fetchUsage();
  assert.deepEqual(data.windows, { "aaaaaaaaaaaa 5h": 20, "bbbbbbbbbbbb 5h": 80 });
  assert.equal(data.resets?.["aaaaaaaaaaaa 5h"], 1900000000000);
  assert.equal(http.mock.callCount(), 2);
  assert.match(provider.render(data, { fg: (_color, text) => text }), /aaaaaaaaaaaa 5h/);
});

test("codex-pool never refreshes tokens or queries expired/login-required accounts", async (t) => {
  t.mock.method(AccountStore.prototype, "read", async () => ({ version: 1, accounts: [
    { id: "expired", credential: { expires: 0 } },
    { id: "login", needsLogin: true, credential: { expires: Date.now() + 60000 } },
  ] }));
  const http = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  await assert.rejects(cfg().fetchUsage(), MissingCredentialError);
  assert.equal(http.mock.callCount(), 0);
});

test("codex-pool errors redact tokens and cancellation reaches requests", async (t) => {
  t.mock.method(AccountStore.prototype, "read", async () => ({ version: 1, accounts: [
    { id: "aaaaaaaaaaaa", credential: { access: "private-token", accountId: "a", expires: Date.now() + 60000 } },
  ] }));
  const controller = new AbortController();
  const http = t.mock.method(globalThis, "fetch", async () => new Response("private-token", { status: 401 }));
  await assert.rejects(cfg().fetchUsage(controller.signal), (error: Error) => {
    assert.doesNotMatch(error.message, /private-token/);
    return true;
  });
  controller.abort();
  assert.equal(http.mock.calls[0].arguments[1]?.signal?.aborted, true);
});
