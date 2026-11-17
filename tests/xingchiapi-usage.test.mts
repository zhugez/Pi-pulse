import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { xingchiapiCfg, formatUsageDetails, resolveRefreshTargets, usageProviderCfgs } from "../extensions/subscription-usage.ts";

const model = { provider: "xingchiapi", id: "test", baseUrl: "https://example.test/v1" };
const ctx = {
 model,
 modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "private-test-key", headers: { "X-Test": "test" } }) },
} as unknown as ExtensionContext;

test("xingchiapi reads balance without generation and renders dock/details", async (t) => {
 t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
  assert.equal(String(url), "https://example.test/v1/usage");
  assert.equal(init?.redirect, "error");
  assert.equal(init?.body, undefined);
  assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer private-test-key");
  assert.equal(new Headers(init?.headers).get("X-Test"), "test");
  return Response.json({ isValid: true, remaining: 42.5, unit: "USD", mode: "unrestricted", usage: { today: { requests: 3 } } });
 });
 const data = await xingchiapiCfg.fetchUsage(undefined, ctx);
 assert.equal(data.balance?.total, 42.5);
 assert.match(xingchiapiCfg.render(data, { fg: (_c, text) => text }), /3 requests today.*\$42.50/);
 assert.match(formatUsageDetails(data, "xingchiapi"), /\$42.50/);
 assert.deepEqual(resolveRefreshTargets("xingchiapi", usageProviderCfgs), [xingchiapiCfg]);
});

test("xingchiapi rejects invalid data and retains negative balances", async (t) => {
 let body: unknown;
 t.mock.method(globalThis, "fetch", async () => Response.json(body));
 for (body of [{}, { isValid: false }, { balance: "42", unit: "USD" }, { balance: 2, unit: "\u001b[2J" }]) {
  await assert.rejects(xingchiapiCfg.fetchUsage(undefined, ctx));
 }
 body = { balance: -1, unit: "USD", planName: "\u001b[2J", mode: "\u001b[2J" };
 const data = await xingchiapiCfg.fetchUsage(undefined, ctx);
 assert.equal(data.balance?.total, -1);
 assert.doesNotMatch(data.plan!, /\u001b/);
});

test("xingchiapi redacts HTTP errors and propagates cancellation", async (t) => {
 t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
  init?.signal?.throwIfAborted();
  return Response.json({ message: "Rejected private-test-key" }, { status: 401 });
 });
 await assert.rejects(xingchiapiCfg.fetchUsage(undefined, ctx), (error: Error) => {
  assert.match(error.message, /HTTP 401/);
  assert.doesNotMatch(error.message, /private-test-key/);
  return true;
 });
 const controller = new AbortController();
 controller.abort();
 await assert.rejects(xingchiapiCfg.fetchUsage(controller.signal, ctx), { name: "AbortError" });
});
