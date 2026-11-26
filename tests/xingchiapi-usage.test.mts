import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
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
 assert.equal(xingchiapiCfg.render(data, { fg: (_c, text) => text }), "xingchi  $42.50 balance   3 req today   unrestricted");
 assert.equal(data.plan, "xingchiapi · unrestricted · 3 requests today");
 assert.match(formatUsageDetails(data, "xingchiapi"), /\$42.50/);
 assert.deepEqual(resolveRefreshTargets("xingchiapi", usageProviderCfgs), [xingchiapiCfg]);
});

test("xingchi ribbon emphasizes the balance and preserves exact counts and plan details", () => {
 const plain = { fg: (_color: string, text: string) => text };
 const roles: string[] = [];
 const colored = { fg: (color: string, text: string) => { roles.push(color); return `\x1b[36m${text}\x1b[39m`; } };
 const data = { windows: {}, balance: { currency: "USD", total: 882.28 }, plan: "xingchiapi · unrestricted · 801 requests today" };
 const expected = "xingchi  $882.28 balance   801 req today   unrestricted";
 for (const style of ["bars", "percent"] as const) assert.equal(xingchiapiCfg.render(data, plain, undefined, style), expected);
 const ansi = xingchiapiCfg.render(data, colored);
 assert.equal(stripVTControlCharacters(ansi), expected);
 assert.ok(ansi.includes("\x1b[1m$882.28\x1b[22m"));
 assert.ok(ansi.includes("38;2;203;166;247mxingchi"));
 assert.ok(ansi.includes("38;2;166;227;161m"));
 assert.ok(ansi.includes("38;2;180;190;254m801"));
 const light = { ...colored, appearance: "light" };
 roles.length = 0;
 const lightAnsi = xingchiapiCfg.render(data, light);
 assert.equal(stripVTControlCharacters(lightAnsi), expected);
 assert.ok(!lightAnsi.includes("38;2;"));
 assert.ok(roles.includes("success") && roles.includes("accent") && roles.includes("muted"));
 assert.doesNotMatch(xingchiapiCfg.render(data, plain), /usage:|○|xingchiapi/);
 assert.ok(!xingchiapiCfg.render(data, plain).includes("\x1b"));
 for (const requests of ["0", "1", "12000", "9007199254740991"]) {
  const text = xingchiapiCfg.render({ ...data, plan: `xingchiapi · capped · ${requests} requests today · renew tomorrow` }, plain);
  assert.ok(text.includes(`${requests} req today`));
  assert.match(text, /capped.*renew tomorrow/);
  assert.doesNotMatch(text, /unrestricted/);
 }
 assert.equal(xingchiapiCfg.render({ windows: {} }, plain), "xingchi");
 const missing = xingchiapiCfg.render({ windows: {}, balance: { currency: "SGD", total: 0 } }, plain);
 assert.match(missing, /0\.00 SGD balance/);
 assert.doesNotMatch(missing, /req today|unrestricted/);
 const negative = xingchiapiCfg.render({ ...data, balance: { currency: "USD", total: -1 } }, colored);
 assert.ok(negative.includes("38;2;243;139;168m"));
 xingchiapiCfg.render({ ...data, balance: { currency: "USD", total: -1 } }, light);
 assert.ok(roles.includes("error"));
 assert.match(stripVTControlCharacters(negative), /\$-1\.00 balance/);
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
