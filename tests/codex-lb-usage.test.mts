import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { codexLbUsageUrl, createCodexLbCfg, normalizePrefs, parseCodexLbUsage } from "../extensions/subscription-usage.ts";

const limit = { limit_type: "credits", limit_window: "5h", max_value: 900, current_value: 83, reset_at: "2027-01-01T00:00:00Z" };

test("codex-lb separates pool used percentages from effective limits", () => {
	assert.deepEqual(parseCodexLbUsage({
		limits: [limit, { ...limit, limit_window: "7d", max_value: 30240, current_value: 2873 }],
		upstream_limits: [{ ...limit, current_value: 899 }],
		account_pool_usage: { primary: 90.75, secondary: 90.5 },
	}), {
		windows: { "Pool 5h used": 9.3, "Pool W used": 9.5, "Limit 5h used": 9.2, "Limit W used": 9.5 },
		resets: { "Limit 5h used": Date.parse(limit.reset_at), "Limit W used": Date.parse(limit.reset_at) },
		plan: "codex-lb",
	});
});

test("quota parser retains distinct units/model limits and validates numbers/resets", () => {
	const data = parseCodexLbUsage({ limits: [
		{ ...limit, current_value: 0, reset_at: "invalid" },
		{ ...limit, limit_type: "total_tokens", current_value: 1000, model_filter: "gpt-6" },
		{ ...limit, max_value: 0 }, { ...limit, current_value: -1 },
		{ ...limit, max_value: Infinity }, { ...limit, current_value: "8" }, null,
	] });
	assert.deepEqual(data.windows, { "Limit 5h used": 0, "Limit 5h total_tokens (gpt-6) used": 100 });
	assert.deepEqual(data.resets, { "Limit 5h total_tokens (gpt-6) used": Date.parse(limit.reset_at) });
	for (const value of [null, {}, { limits: [] }, { rate_limit: null }, { limits: [null] }]) {
		assert.throws(() => parseCodexLbUsage(value), /no quota limits/);
	}
});

test("pool-only data works without fabricating resets or null windows", () => {
	assert.deepEqual(parseCodexLbUsage({ account_pool_usage: { primary: 75, secondary: null } }), {
		windows: { "Pool 5h used": 25 }, resets: {}, plan: "codex-lb",
	});
	assert.deepEqual(parseCodexLbUsage({ account_pool_usage: { primary: 0, secondary: 100 } }).windows,
		{ "Pool 5h used": 100, "Pool W used": 0 });
	assert.throws(() => parseCodexLbUsage({ account_pool_usage: { primary: -1, secondary: 101 } }), /no quota/);
});

test("usage URL preserves proxy path prefixes and rejects ambiguous/unsafe URLs", () => {
	assert.equal(codexLbUsageUrl("http://macmini:2455/v1/"), "http://macmini:2455/v1/usage");
	assert.equal(codexLbUsageUrl("https://proxy.example/codex/v1"), "https://proxy.example/codex/v1/usage");
	for (const url of ["file:///v1", "https://u:p@proxy/v1", "https://proxy/v1?key=secret", "https://proxy/v1#x", "https://proxy", "junk"]) {
		assert.throws(() => codexLbUsageUrl(url));
	}
});

test("codex-lb providers are explicit, validated and deduplicated", () => {
	assert.deepEqual(normalizePrefs({ mode: "off", codexLbProviders: ["macmini-codex", "macmini-codex", "", 42, "bad\nname"] }), {
		mode: "off", codexLbProviders: ["macmini-codex"],
	});
	assert.deepEqual(normalizePrefs({ codexLbProviders: "macmini-codex" }), { mode: "bars" });
});

test("codex-lb resolves non-active providers through registry and honours runtime URL/headers", async (t) => {
	const model = { provider: "custom-lb", id: "gpt", baseUrl: "https://unused.example/v1" };
	const ctx = {
		model: { provider: "another-provider" },
		modelRegistry: {
			getAll: () => [model],
			getApiKeyAndHeaders: async (selected: unknown) => {
				assert.equal(selected, model);
				return { ok: true, apiKey: "old", baseUrl: "https://runtime.example/prefix/v1", headers: { Authorization: "Bearer actual-secret" } };
			},
		},
	} as unknown as ExtensionContext;
	const http = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ limits: [limit] })));
	const controller = new AbortController();
	await createCodexLbCfg("custom-lb").fetchUsage(controller.signal, ctx);
	const [url, options] = http.mock.calls[0].arguments;
	assert.equal(url, "https://runtime.example/prefix/v1/usage");
	assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer actual-secret");
	controller.abort();
	assert.equal(options?.signal?.aborted, true);
});

test("codex-lb failures redact credentials and do not recommend unrelated OAuth login", async (t) => {
	const ctx = {
		model: { provider: "custom-lb", baseUrl: "https://proxy.example/v1" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, headers: { Authorization: "Bearer private-key" } }) },
	} as unknown as ExtensionContext;
	t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "Rejected private-key\n" } }), { status: 401 }));
	await assert.rejects(createCodexLbCfg("custom-lb").fetchUsage(undefined, ctx), (error: Error) => {
		assert.match(error.message, /HTTP 401.*invalid_api_key/);
		assert.doesNotMatch(error.message, /private-key|\/login|\n/);
		return true;
	});
});
