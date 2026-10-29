import assert from "node:assert/strict";
import test from "node:test";
import { AccountStore, accountDisplayName } from "../extensions/codex-pool/store.ts";
import type { OAuthCredential } from "@earendil-works/pi-ai";

const credentialWithClaims = (claims: unknown): OAuthCredential => ({
  type: "oauth", access: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
  refresh: "test-refresh", expires: Date.now() + 60000,
});

test("account display prefers email, then name, and safely falls back", () => {
  const profile = (value: unknown) => credentialWithClaims({ "https://api.openai.com/profile": value });
  assert.equal(accountDisplayName(profile({ email: "alice@example.com", name: "Alice" }), "Account 1"), "alice@example.com");
  assert.equal(accountDisplayName(profile({ name: "Alice" }), "Account 1"), "Alice");
  assert.equal(accountDisplayName(credentialWithClaims({ email: "bob@example.com" }), "Account 1"), "bob@example.com");
  assert.equal(accountDisplayName(profile({ name: "\u001b\nAlice\u202e" }), "Account 1"), "Alice");
  assert.equal(accountDisplayName(profile({ email: 42 }), "Account 1"), "Account 1");
  assert.equal(accountDisplayName({ access: "invalid" } as OAuthCredential, "Account 1"), "Account 1");
});

test("pool usage displays email and keeps duplicate account names separate", async (t) => {
  t.mock.method(AccountStore.prototype, "read", async () => ({ version: 1, accounts: [
    { id: "one", credential: credentialWithClaims({ "https://api.openai.com/profile": { email: "same@example.com" } }) },
    { id: "two", credential: credentialWithClaims({ "https://api.openai.com/profile": { email: "same@example.com" } }) },
    { id: "three", credential: credentialWithClaims({ "https://api.openai.com/profile": { name: "Alice" } }) },
  ] }));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ rate_limit: { primary_window: {
    used_percent: 20, limit_window_seconds: 18000,
  } } })));
  const data = await cfg().fetchUsage();
  assert.deepEqual(data.windows, {
    "same@example.com (Account 1) 5h": 20,
    "same@example.com (Account 2) 5h": 20,
    "Alice 5h": 20,
  });
  assert.match(cfg().render(data, { fg: (_color, text) => text }), /same@example.com/);
});
import { formatUsageDetails, antigravityCfg, renderCodexPoolFooter, usageProviderCfgs, resolveRefreshTargets, MissingCredentialError } from "../extensions/subscription-usage.ts";

test("pool footer shows only selected account, shortens names and handles collisions", () => {
  const theme = { fg: (_color: string, text: string) => text };
  const data: import("../extensions/subscription-usage.ts").UsageData & { accounts: NonNullable<import("../extensions/subscription-usage.ts").UsageData["accounts"]> } = { windows: {}, accounts: [
    { id: "a", name: "alice@example.com", active: true, windows: { "5h": 2, weekly: 3 } },
    { id: "b", name: "bob@example.com", windows: { weekly: 80 } },
  ] };
  assert.equal(renderCodexPoolFooter(data, theme), "alice · 5h: ░░░░░░  2% · W: ░░░░░░  3%");
  assert.equal(renderCodexPoolFooter(data, theme, "b"), "bob · W: █████░  80%");
  assert.equal(renderCodexPoolFooter(data, theme, "a", "percent"), "alice · 5h 2% · W 3%");
  const colored = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
  const rendered = renderCodexPoolFooter(data, colored, "b");
  const antigravity = antigravityCfg.render({ windows: { "3p-weekly": 80 } }, colored, "gpt", "bars");
  assert.ok(rendered.endsWith(antigravity), "quota colors and bars match Antigravity exactly");
  assert.equal(renderCodexPoolFooter(data, theme, "missing"), "Codex · usage pending");
  data.accounts[1].name = "alice@other.com";
  assert.match(renderCodexPoolFooter(data, theme, "b"), /alice@other.com/);
});

test("Codex dashboard shows display names instead of internal IDs, including a single account", () => {
  const theme = { fg: (_color: string, text: string) => `\u001b[32m${text}\u001b[0m` };
  for (const count of [1, 2]) {
    const accounts = Array.from({ length: count }, (_, index) => ({
      id: `internal-hash-${index}`, name: `user${index}@example.com`, active: index === 0,
      windows: { weekly: 7 },
    }));
    const output = formatUsageDetails({ windows: {}, accounts, plan: "codex-pool" }, "codex-pool", { theme });
    assert.match(output, /user0@example.com/);
    assert.doesNotMatch(output, /internal-hash/);
    assert.match(output, /active/);
  }
});

test("Business Pro Lite badge is readable without changing the API plan code", () => {
  const data = { windows: {}, plan: "codex-pool", accounts: [
    { id: "a", name: "alice@example.com", plan: "self_serve_business_prolite", windows: { weekly: 7 } },
  ] };
  const output = formatUsageDetails(data, "codex-pool", {
    theme: { fg: (_color, text) => `\u001b[32m${text}\u001b[0m` },
  });
  assert.match(output, /Business \(Pro Lite\)/);
  assert.doesNotMatch(output, /self_serve_business_prolite/);
  assert.equal(data.accounts[0].plan, "self_serve_business_prolite");
  assert.match(formatUsageDetails(data, "codex-pool"), /self_serve_business_prolite/);
});

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
    return new Response(JSON.stringify({ plan_type: first ? "plus" : "pro", rate_limit: { primary_window: {
      used_percent: first ? 20 : 80, limit_window_seconds: 18000, reset_at: 1900000000,
    } } }));
  });
  const data = await provider.fetchUsage();
  assert.deepEqual(data.windows, { "Account 1 5h": 20, "Account 2 5h": 80 });
  assert.equal(data.resets?.["Account 1 5h"], 1900000000000);
  assert.deepEqual(data.accounts?.map((account) => account.plan), ["plus", "pro"]);
  const dashboard = formatUsageDetails(data, "codex-pool", { theme: { fg: (_color, text) => `\u001b[32m${text}\u001b[0m` } });
  assert.match(dashboard, /plus/);
  assert.match(dashboard, /pro/);
  assert.equal(http.mock.callCount(), 2);
  const rendered = provider.render(data, { fg: (_color, text) => text });
  assert.match(rendered, /Account 1 5h/);
  assert.match(rendered, /Account 2 5h/);
  assert.doesNotMatch(rendered, /aaaaaaaaaaaa|bbbbbbbbbbbb/);
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
