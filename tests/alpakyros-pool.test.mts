import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { createPoolStream } from "../extensions/alpakyros-pool/index.ts";

const model = { id: "test", api: "openai-completions", provider: "alpakyros-pool" } as Model<string>;
const context = { messages: [] } as unknown as TranscriptContext;
const message = (): AssistantMessage => ({ role: "assistant", content: [], api: model.api,
  provider: model.provider, model: model.id, stopReason: "error", timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

for (const status of [429, 401, 403, 500]) {
  test(`pool bounds failover for HTTP ${status} and sticks to successful key`, async () => {
    const tried: string[] = [];
    const delegate = ((_model: unknown, _ctx: unknown, options: any) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        tried.push(options.apiKey);
        await options.fetch("https://example.invalid", {});
        const output = message();
        if (options.apiKey === "a") stream.push({ type: "error", reason: "error", error: output });
        else { output.stopReason = "stop"; stream.push({ type: "done", reason: "stop", message: output }); }
        stream.end();
      })();
      return stream;
    }) as Parameters<typeof createPoolStream>[1];
    const pool = createPoolStream([{ key: "a" }, { key: "b" }], delegate);
    const options = { fetch: async () => new Response(null, { status: tried.at(-1) === "a" ? status : 200 }) };
    const first = await pool(model, context, options).result();
    assert.deepEqual(tried, status === 500 ? ["a"] : ["a", "b"]);
    assert.equal(first.stopReason, status === 500 ? "error" : "stop");
    if (status !== 500) {
      await pool(model, context, options).result();
      assert.equal(tried.at(-1), "b");
    }
  });
}

test("partial content suppresses replay and secrets are never returned in errors", async () => {
  let attempts = 0;
  const delegate = ((_model: unknown, _ctx: unknown, options: any) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      attempts++;
      await options.fetch("https://example.invalid", {});
      const output = message();
      output.content = [{ type: "text", text: "hello" }];
      stream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial: output });
      output.errorMessage = "secret-key";
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    })();
    return stream;
  }) as Parameters<typeof createPoolStream>[1];
  const pool = createPoolStream([{ key: "secret-key" }, { key: "b" }], delegate);
  const result = await pool(model, context, { fetch: async () => new Response(null, { status: 429 }) }).result();
  assert.equal(attempts, 1);
  assert.match(result.errorMessage!, /replay suppressed/);
  assert.doesNotMatch(result.errorMessage!, /secret-key/);
});

test("cancellation makes no request", async () => {
  const controller = new AbortController();
  controller.abort();
  const pool = createPoolStream([{ key: "a" }], (() => { throw new Error("should not call"); }) as any);
  const result = await pool(model, context, { signal: controller.signal }).result();
  assert.equal(result.stopReason, "aborted");
});
