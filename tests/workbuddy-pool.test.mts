import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchCatalog, STATIC_CATALOG, toPiModels } from "../extensions/workbuddy-pool/catalog.ts";
import {
  cleanupOrphanToolCalls,
  mergeAdjacentToolCalls,
  normalizeReasoningEffort,
  prepareBody,
  repackToolResultBlocks,
} from "../extensions/workbuddy-pool/payload.ts";
import { AccountStore, importPanelAuths } from "../extensions/workbuddy-pool/store.ts";
import { createWorkBuddyFetch } from "../extensions/workbuddy-pool/transport.ts";

const account = { uid: "uid-1234-abcd", realm: "global" as const, accessToken: "a", refreshToken: "r", expiresAt: 0 };

function body(messages: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: "glm-5.3", messages, ...extra };
}

test("prepareBody forces streaming and usage reporting", () => {
  const out = prepareBody(body([{ role: "user", content: "hi" }]), { model: "glm-5.3", uid: "uid" }) as Record<string, unknown>;
  assert.equal(out.stream, true);
  assert.deepEqual(out.stream_options, { include_usage: true });
});

test("prepareBody translates max_completion_tokens and clamps small GPT limits", () => {
  const out = prepareBody(body([{ role: "user", content: "hi" }], { model: "gpt-5.6-sol", max_completion_tokens: 4 }), {
    model: "gpt-5.6-sol",
    uid: "uid",
  }) as Record<string, unknown>;
  assert.equal(out.max_tokens, 16);
  assert.equal("max_completion_tokens" in out, false);
});

test("prepareBody rewrites object tool_choice to a string", () => {
  const out = prepareBody(
    body([{ role: "user", content: "hi" }], { tool_choice: { type: "function", function: { name: "Read" } } }),
    { model: "glm-5.3", uid: "uid" },
  ) as Record<string, unknown>;
  assert.equal(out.tool_choice, "Read");
});

test("prepareBody normalizes developer role and string image_url", () => {
  const out = prepareBody(
    body([
      { role: "developer", content: "be brief" },
      { role: "user", content: [{ type: "image_url", image_url: "data:image/png;base64,xx" }] },
    ]),
    { model: "glm-5.3", uid: "uid" },
  ) as { messages: Array<{ role: string; content: unknown }> };
  assert.equal(out.messages[0].role, "system");
  assert.deepEqual((out.messages[1].content as Array<Record<string, unknown>>)[0].image_url, { url: "data:image/png;base64,xx" });
});

test("prepareBody injects deepseek thinking with an effort level", () => {
  const out = prepareBody(body([{ role: "user", content: "hi" }], { model: "deepseek-v4.1-flash" }), {
    model: "deepseek-v4.1-flash",
    uid: "uid",
    defaultEfforts: { "deepseek-v4.1-flash": "high" },
  }) as Record<string, unknown>;
  assert.deepEqual(out.thinking, { type: "enabled" });
  assert.equal(out.reasoning_effort, "high");
});

test("prepareBody adds a system message first for the global realm", () => {
  const out = prepareBody(body([{ role: "user", content: "hi" }]), { model: "glm-5.3", uid: "uid", ensureSystem: true }) as {
    messages: Array<{ role: string }>;
  };
  assert.equal(out.messages[0].role, "system");
});

test("prompt_cache_key is stable per account and never shared across accounts", () => {
  const first = prepareBody(body([{ role: "user", content: "hi" }]), { model: "glm-5.3", uid: "aaaa1111", conversationId: "conv" }) as Record<string, unknown>;
  const again = prepareBody(body([{ role: "user", content: "hi" }]), { model: "glm-5.3", uid: "aaaa1111", conversationId: "conv" }) as Record<string, unknown>;
  const other = prepareBody(body([{ role: "user", content: "hi" }]), { model: "glm-5.3", uid: "bbbb2222", conversationId: "conv" }) as Record<string, unknown>;
  assert.equal(first.prompt_cache_key, again.prompt_cache_key);
  assert.notEqual(first.prompt_cache_key, other.prompt_cache_key);
});

test("tool pairing drops orphan calls and results", () => {
  const messages = [
    { role: "user", content: "run it" },
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
    { role: "assistant", tool_calls: [{ id: "c2", type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ];
  const merged = mergeAdjacentToolCalls(messages);
  assert.equal(merged.messages.length, 3);
  const cleaned = cleanupOrphanToolCalls(merged.messages);
  const assistant = cleaned.messages[1] as { tool_calls: Array<{ id: string }> };
  assert.deepEqual(assistant.tool_calls.map((call) => call.id), ["c1"]);
});

test("tool pairing moves a notice wedged between results", () => {
  const messages = [
    { role: "assistant", tool_calls: [{ id: "c1" }, { id: "c2" }] },
    { role: "tool", tool_call_id: "c1", content: "a" },
    { role: "system", content: "<image_resize_notice>" },
    { role: "tool", tool_call_id: "c2", content: "b" },
  ];
  const repacked = repackToolResultBlocks(messages);
  assert.deepEqual(repacked.messages.map((message) => (message as { role: string }).role), ["assistant", "tool", "tool", "system"]);
});

test("reasoning effort is clamped to the supported ladder", () => {
  const out: Record<string, unknown> = { model: "glm-5.3", reasoning_effort: "max" };
  normalizeReasoningEffort(out, { "glm-5.3": ["low", "high"] });
  assert.equal(out.reasoning_effort, "high");
});

test("global DeepSeek V4.1 Flash clamps unsupported max to high", () => {
  const out = prepareBody(body([{ role: "user", content: "hi" }], {
    model: "deepseek-v4.1-flash",
    reasoning_effort: "max",
  }), {
    model: "deepseek-v4.1-flash",
    uid: "uid",
    realm: "global",
    efforts: { "deepseek-v4.1-flash": ["low", "high", "max"] },
  }) as Record<string, unknown>;
  assert.equal(out.reasoning_effort, "high");
});

test("catalog maps upstream models into pi models with effort maps", async () => {
  const verificationTestVector = {
    code: 0,
    data: {
      models: [
        { id: "global:glm-5.3", name: "GLM 5.3", maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true,
          reasoning: { supportedEfforts: ["low", "high", "max"], defaultEffort: "high" } },
        { id: "kimi-k3", name: "Kimi K3", maxAllowedSize: 256_000, maxOutputTokens: 32_000, supportsImages: false },
      ],
    },
  };
  {
    const stub = (async () => new Response(JSON.stringify(verificationTestVector), { status: 200 })) as typeof fetch;
    const catalog = await fetchCatalog(account, undefined, stub);
    assert.deepEqual(catalog.efforts["glm-5.3"], ["low", "high", "max"]);
    assert.equal(catalog.models[0].id, "glm-5.3");
    assert.equal(catalog.defaultEfforts["glm-5.3"], "high");
    const models = toPiModels(catalog, "https://example.test/v2");
    assert.equal(models.length, 2);
    assert.equal(models[0].reasoning, true);
    assert.deepEqual(models[0].input, ["text", "image"]);
    assert.equal(models[1].contextWindow, 256_000);
    assert.equal(models[1].reasoning, false);
  }
});

test("static catalog starts with a directly callable DeepSeek model", () => {
  assert.equal(STATIC_CATALOG.models[0].id, "deepseek-v4.1-flash");
  assert.deepEqual(STATIC_CATALOG.efforts["deepseek-v4.1-flash"], ["low", "high", "max"]);
});

test("6004 model limits fail over and persist per-model cooldown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-transport-"));
  const store = new AccountStore(join(dir, "accounts.json"));
  await store.upsert({ ...account, uid: "first", nickname: "first" });
  await store.upsert({ ...account, uid: "second", nickname: "second" });
  const calls: string[] = [];
  const upstreamFetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model?: string };
    const uid = String(new Headers(init?.headers).get("x-user-id"));
    calls.push(`${uid}:${body.model}`);
    if (uid === "first") {
      return new Response(JSON.stringify({
        code: 6004,
        msg: "usage exceeds frequency limit, but don't worry, your usage will reset at 2099-01-01 00:00:00 UTC+8",
      }), { status: 429 });
    }
    return new Response("data: [DONE]\\n\\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const transport = createWorkBuddyFetch({
    store,
    catalog: () => ({ models: [], efforts: {}, defaultEfforts: {} }),
    upstreamFetch,
    maxAttempts: 2,
  });
  const response = await transport.fetch("https://www.workbuddy.ai/v2/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["first:deepseek-v4.1-flash", "second:deepseek-v4.1-flash"]);
  const saved = await store.read();
  assert.ok((saved.accounts[0].modelCooldowns?.["deepseek-v4.1-flash"] ?? 0) > Date.now());
});

test("6004 does not retry a model when every account is blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-transport-blocked-"));
  const store = new AccountStore(join(dir, "accounts.json"));
  const reset = Date.now() + 60_000;
  await store.upsert({ ...account, uid: "first", modelCooldowns: { "deepseek-v4.1-flash": reset } });
  await store.upsert({ ...account, uid: "second", modelCooldowns: { "deepseek-v4.1-flash": reset } });
  const transport = createWorkBuddyFetch({
    store,
    catalog: () => ({ models: [], efforts: {}, defaultEfforts: {} }),
    upstreamFetch: (async () => { throw new Error("should not call upstream"); }) as typeof fetch,
  });
  const response = await transport.fetch("https://www.workbuddy.ai/v2/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [] }),
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /cooling down/);
});

test("panel auth files import into the account store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-panel-"));
  await writeFile(join(dir, "workbuddy-1.json"), JSON.stringify({
    account: { uid: "uid-1", nickname: "tester@example.com" },
    auth: { accessToken: "access", refreshToken: "refresh", expiresAt: "1824203365", domain: "www.workbuddy.ai", realm: "global" },
  }));
  await writeFile(join(dir, "broken.json"), "{not json");
  const imported = await importPanelAuths(dir);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].realm, "global");
  assert.equal(imported[0].expiresAt, 1824203365);

  const store = new AccountStore(join(dir, "accounts.json"));
  await store.upsert(imported[0]);
  await store.upsert({ ...imported[0], nickname: "renamed" });
  const data = await store.read();
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].nickname, "renamed");
});
