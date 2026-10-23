import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { alpakyrosPoolCfg, usageProviderCfgs, resolveRefreshTargets } from "../extensions/subscription-usage.ts";

test("Alpakyros usage checks billing without activation and renders inactive unlimited keys", async (t) => {
  t.mock.method(fs, "readFileSync", () => JSON.stringify({ baseUrl: "https://gateway.invalid/v1", keys: ["private-key"] }));
  const http = t.mock.method(globalThis, "fetch", async (url: unknown, options?: RequestInit) => {
    assert.equal(String(url), "https://gateway.invalid/api/v1/keys/status");
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    assert.deepEqual(JSON.parse(String(options?.body)), { key: "private-key" });
    return Response.json({ state: "inactive", is_unlimited: true, key_quota: { remaining_percentage: 100 } });
  });
  assert.ok(usageProviderCfgs.includes(alpakyrosPoolCfg));
  assert.deepEqual(resolveRefreshTargets("alpakyros-pool", usageProviderCfgs), [alpakyrosPoolCfg]);
  const data = await alpakyrosPoolCfg.fetchUsage();
  assert.deepEqual(data.windows, {});
  assert.match(alpakyrosPoolCfg.render(data, { fg: (_color, text) => text }), /Key 1 inactive · unlimited/);
  assert.doesNotMatch(JSON.stringify(data), /private-key/);
  http.mock.mockImplementation(async () => Response.json({ state: "active", key_quota: { remaining_percentage: 75 } }));
  assert.deepEqual((await alpakyrosPoolCfg.fetchUsage()).windows, { "Key 1 active": 25 });
  http.mock.mockImplementation(async () => new Response("private-key", { status: 403 }));
  await assert.rejects(alpakyrosPoolCfg.fetchUsage(), /status HTTP 403/);
});
