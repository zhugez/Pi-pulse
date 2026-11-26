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
