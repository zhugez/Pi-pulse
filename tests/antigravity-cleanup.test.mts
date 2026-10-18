import assert from "node:assert/strict";
import test from "node:test";
import { antigravityFetch, prewarmConnection } from "../extensions/antigravity/utils/http.ts";
import { DEFAULT_PROJECT_ID, defaultProjectId } from "../extensions/antigravity/client/client.ts";
import { getCurrentAntigravityCatalog } from "../extensions/antigravity/models/models.ts";

test("antigravityFetch delegates directly to native fetch", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string | URL; init?: RequestInit }> = [];

  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    const res = await antigravityFetch("https://example.com/test", {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input, "https://example.com/test");
    assert.equal(calls[0]?.init?.method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prewarmConnection honours NO_PREWARM flag", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalNoPrewarm = process.env.ANTIGRAVITY_NO_PREWARM;
  const calls: Array<{ input: string | URL; init?: RequestInit }> = [];

  try {
    process.env.ANTIGRAVITY_NO_PREWARM = "1";
    t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(null, { status: 200 });
    });

    prewarmConnection("https://example.com/disabled");
    assert.equal(calls.length, 0);
  } finally {
    if (originalNoPrewarm !== undefined) {
      process.env.ANTIGRAVITY_NO_PREWARM = originalNoPrewarm;
    } else {
      delete process.env.ANTIGRAVITY_NO_PREWARM;
    }
    globalThis.fetch = originalFetch;
  }
});

test("preserves deprecated DEFAULT_PROJECT_ID and defaultProjectId fallback", () => {
  assert.equal(typeof DEFAULT_PROJECT_ID, "string");
  assert.ok(DEFAULT_PROJECT_ID.length > 0);
  assert.equal(typeof defaultProjectId("test-seed"), "string");
  assert.ok(defaultProjectId("test-seed").length > 0);
});

test("preserves catalog accessors and routing", () => {
  const catalog = getCurrentAntigravityCatalog();
  assert.ok(Array.isArray(catalog.models));
  assert.ok(catalog.models.length > 0);
  assert.ok(catalog.routing);
});

test("Antigravity account rotation and cooldown lifecycle", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const {
    acquireNextAccount,
    failoverToNextAccount,
    markAccountCooldown,
    listAccounts,
    setAccountRotation,
    isAccountRotationEnabled,
  } = await import("../extensions/antigravity/auth/accounts.ts");

  const tempAgentDir = mkdtempSync(join(tmpdir(), "pi-pulse-ag-test-"));
  const prevEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;

  try {
    const initialAccounts = {
      version: 1,
      activeAccountId: "user1@gmail.com",
      accounts: {
        "user1@gmail.com": {
          accountId: "user1@gmail.com",
          email: "user1@gmail.com",
          access: "tok_user1",
          refresh: "ref_user1",
          expires: Date.now() + 3600_000,
          addedAt: 1000,
          lastUsedAt: 1000,
        },
        "user2@gmail.com": {
          accountId: "user2@gmail.com",
          email: "user2@gmail.com",
          access: "tok_user2",
          refresh: "ref_user2",
          expires: Date.now() + 3600_000,
          addedAt: 2000,
          lastUsedAt: 500,
        },
      },
    };
    writeFileSync(join(tempAgentDir, "antigravity-accounts.json"), JSON.stringify(initialAccounts, null, 2));
    writeFileSync(join(tempAgentDir, "auth.json"), JSON.stringify({}, null, 2));

    assert.equal(isAccountRotationEnabled(), true);

    // Initial rotation: user2 has older lastUsedAt (500 vs 1000), so it should be acquired first
    const acc1 = await acquireNextAccount();
    assert.equal(acc1?.token, "tok_user2");

    // Second rotation: user1 now has older lastUsedAt (1000 vs current time)
    const acc2 = await acquireNextAccount();
    assert.equal(acc2?.token, "tok_user1");

    // Mark user2 on cooldown
    markAccountCooldown("tok_user2", 30_000);
    const list = listAccounts();
    const u2 = list.find((a) => a.accountId === "user2@gmail.com");
    assert.equal(u2?.cooldown, true);

    // Acquire next: user2 is on cooldown, so user1 is selected even if recently used
    const acc3 = await acquireNextAccount();
    assert.equal(acc3?.token, "tok_user1");

    // Failover: tried user1, should failover to user2
    const failoverAcc = await failoverToNextAccount(new Set(["tok_user1"]));
    assert.equal(failoverAcc?.token, "tok_user2");

    // Toggle rotation off
    setAccountRotation(false);
    assert.equal(isAccountRotationEnabled(), false);
  } finally {
    if (prevEnv !== undefined) {
      process.env.PI_CODING_AGENT_DIR = prevEnv;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    rmSync(tempAgentDir, { recursive: true, force: true });
  }
});
