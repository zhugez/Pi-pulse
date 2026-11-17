import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { hmsCfg, formatUsageDetails, usesDeepSeekPeakPricing, usageProviderCfgs, resolveRefreshTargets } from "../extensions/subscription-usage.ts";

test("HMS reads daily quota without generating tokens and does not show direct DeepSeek pricing", async (t) => {
	t.mock.method(fs, "openSync", () => { throw Object.assign(new Error(), { code: "ENOENT" }); });
	t.mock.method(fs, "readFileSync", () => JSON.stringify({ hms: { type: "api_key", key: "private-test-key" } }));
	let headers: Record<string, string> = {
		"x-quota-limit": "300000000", "x-quota-used": "75000000", "x-quota-reset": "2026-11-17T00:00:00.000Z",
	};
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
		assert.equal(String(url), "https://100milionseek.top/v1/models");
		assert.equal(init?.method ?? "GET", "GET");
		assert.equal(init?.body, undefined);
		assert.equal(init?.redirect, "error");
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer private-test-key");
		return new Response("{}", { headers });
	});
	const data = await hmsCfg.fetchUsage();
	assert.deepEqual(data.windows, { daily: 25 });
	assert.deepEqual(data.resets, { daily: Date.parse("2026-11-17T00:00:00.000Z") });
	assert.match(hmsCfg.render(data, { fg: (_color, text) => text }), /25%.*225,000,000 \/ 300,000,000 tokens left/);
	assert.equal(usesDeepSeekPeakPricing("hms", "deepseek-v4.1-flash-free"), false);
	assert.doesNotMatch(formatUsageDetails(data, "hms", { modelId: "deepseek-v4.1-flash-free" }), /peak/i);
	assert.deepEqual(resolveRefreshTargets("hms", usageProviderCfgs), [hmsCfg]);
	for (const bad of [{}, { ...headers, "x-quota-limit": "0" }, { ...headers, "x-quota-used": "NaN" }, { ...headers, "x-quota-reset": "invalid" }]) {
		headers = bad;
		await assert.rejects(hmsCfg.fetchUsage(), /invalid quota headers/);
	}
});

test("HMS pool sums eight unique keys and rejects incomplete totals", async (t) => {
	const keys = Array.from({ length: 8 }, (_, i) => `private-${i}`);
	t.mock.method(fs, "openSync", () => 42);
	t.mock.method(fs, "fstatSync", () => ({ isFile: () => true, mode: 0o600, uid: process.getuid?.() }));
	t.mock.method(fs, "closeSync", () => {});
	t.mock.method(fs, "readFileSync", () => JSON.stringify({ baseUrl: "https://100milionseek.top/v1", keys: [...keys, keys[0]] }));
	const seen: string[] = [];
	let failed = false;
	t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
		seen.push(new Headers(init?.headers).get("Authorization")!);
		return new Response("{}", { status: failed ? 401 : 200, headers: {
			"x-quota-limit": "300000000", "x-quota-used": "1000000", "x-quota-remaining": "299000000",
			"x-quota-reset": "2026-11-17T00:00:00.000Z",
		} });
	});
	const data = await hmsCfg.fetchUsage();
	assert.equal(seen.length, 8);
	assert.equal(new Set(seen).size, 8);
	assert.match(data.plan!, /2,392,000,000 \/ 2,400,000,000 tokens left · 8 keys/);
	assert.equal(hmsCfg.sharedCache, false);
	assert.match(formatUsageDetails(data, "hms"), /2,392,000,000/);
	failed = true;
	await assert.rejects(hmsCfg.fetchUsage(), /HTTP 401; pool total unknown/);
});

test("HMS errors never expose the credential", async (t) => {
	t.mock.method(fs, "openSync", () => { throw Object.assign(new Error(), { code: "ENOENT" }); });
	t.mock.method(fs, "readFileSync", () => JSON.stringify({ hms: { type: "api_key", key: "private-test-key" } }));
	t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { message: "invalid private-test-key" } }), { status: 401 }));
	await assert.rejects(hmsCfg.fetchUsage(), (error: Error) => {
		assert.match(error.message, /HTTP 401/);
		assert.ok(!error.message.includes("private-test-key"));
		return true;
	});
});
