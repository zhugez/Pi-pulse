import assert from "node:assert/strict";
import test from "node:test";
import { refreshAccount } from "../extensions/workbuddy-pool/auth.ts";

const account = { uid: "test", realm: "global" as const, accessToken: "old", refreshToken: "refresh", expiresAt: 1 };

test("refresh unwraps the upstream data envelope", async () => {
  const result = await refreshAccount(account, undefined, async () => new Response(JSON.stringify({
    code: 0, data: { accessToken: "new", refreshToken: "rotated", expiresIn: 3600 },
  })));
  assert.equal(result?.accessToken, "new");
  assert.equal(result?.refreshToken, "rotated");
  assert.ok(result!.expiresAt > Date.now() / 1000);
});

test("transient refresh failures do not report invalid credentials", async () => {
  await assert.rejects(refreshAccount(account, undefined, async () => new Response("unavailable", { status: 503 })), /HTTP 503/);
  await assert.rejects(refreshAccount(account, undefined, async () => new Response("not json")), /invalid response/);
});

test("rejected credentials require login", async () => {
  assert.equal(await refreshAccount(account, undefined, async () => new Response("", { status: 401 })), null);
});
