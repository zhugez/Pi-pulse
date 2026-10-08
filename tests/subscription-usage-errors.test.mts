import assert from "node:assert/strict";
import fs from "node:fs";
import test, { type TestContext } from "node:test";
import { antigravityCfg, codexCfg, deepseekCfg, opencodeCfg } from "../extensions/subscription-usage.ts";

function isolateEnv(t: TestContext) {
	const keys = ["OPENAI_CODEX_TOKEN", "CODEX_ACCESS_TOKEN", "CHATGPT_ACCESS_TOKEN", "ANTIGRAVITY_TOKEN", "ANTIGRAVITY_API_KEY", "ANTIGRAVITY_BASE_URL", "OPENCODE_API_KEY", "DEEPSEEK_API_KEY"];
	for (const key of keys) {
		const value = process.env[key];
		delete process.env[key];
		t.after(() => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
	}
}

for (const cfg of [codexCfg, antigravityCfg, opencodeCfg, deepseekCfg]) {
	test(`${cfg.id} preserves API error details and hides credentials`, async (t) => {
		isolateEnv(t);
		const secret = "test-private-access-token";
		t.mock.method(fs, "readFileSync", () => JSON.stringify({
			[cfg.id]: { type: cfg === codexCfg || cfg === antigravityCfg ? "oauth" : "api_key", access: secret, key: secret },
		}));
		const status = cfg === antigravityCfg ? 403 : 401;
		const code = status === 403 ? "PERMISSION_DENIED" : "token_revoked";
		const fetch = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
			error: { code, message: `No valid license (#3501). ${secret}` },
		}), { status }));
		await assert.rejects(cfg.fetchUsage(), (error: Error) => {
			assert.match(error.message, new RegExp(`HTTP ${status}.*${code}`));
			assert.match(error.message, /#3501/);
			assert.ok(!error.message.includes(secret));
			assert.match(error.message, /login|credential/i);
			return true;
		});
		if (cfg === antigravityCfg) assert.equal(fetch.mock.callCount(), 3);
	});
}

test("non-JSON errors retain HTTP status without dumping HTML", async (t) => {
	isolateEnv(t);
	t.mock.method(fs, "readFileSync", () => JSON.stringify({ "openai-codex": { type: "oauth", access: "test" } }));
	t.mock.method(globalThis, "fetch", async () => new Response("<html>upstream failure</html>", { status: 502 }));
	await assert.rejects(codexCfg.fetchUsage(), /^Error: HTTP 502$/);
});
