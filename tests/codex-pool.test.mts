import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  defaultProviderAuthContext,
  isRetryableAssistantError,
  normalizeContext,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import codexPoolExtension from "../extensions/codex-pool/index.ts";
import { cooldownUntil, createCodexPool, PROVIDER_ID } from "../extensions/codex-pool/provider.ts";
import { AccountStore, accountIdentity, PoolError } from "../extensions/codex-pool/store.ts";

function fakeJwt(sub: string, accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function makeCredential(sub: string, accountId: string, refresh = "ref-1", expires = Date.now() + 3_600_000): OAuthCredential {
  return {
    type: "oauth",
    access: fakeJwt(sub, accountId),
    refresh,
    expires,
    accountId,
  };
}

const dummyModel = {
  ...openaiCodexProvider().getModels()[0],
  provider: PROVIDER_ID,
};

const makeContext = (messages: Message[] = []): TranscriptContext => normalizeContext({ messages });

const makeErrorMessage = (errorMessage: string): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-codex",
  provider: PROVIDER_ID,
  model: dummyModel.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "error",
  errorMessage,
  timestamp: Date.now(),
});

function sseResponse(events: string[]): Response {
  const body = events.map((e) => `data: ${e}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

test("1. Stable IDs, duplicate login replacement, ambiguous prefixes, preferred removal", async () => {
  const cred1 = makeCredential("user-1", "acc-aaa");
  const cred2 = makeCredential("user-2", "acc-bbb");

  const id1 = accountIdentity(cred1);
  const id1Again = accountIdentity(cred1);
  assert.equal(id1, id1Again);
  assert.equal(id1, createHash("sha256").update(`acc-aaa\0user-1`).digest("hex"));

  const id2 = accountIdentity(cred2);
  assert.notEqual(id1, id2);

  // Rejects invalid JWT claims
  assert.throws(() => accountIdentity({ ...cred1, access: "invalid.jwt.token" }), PoolError);
  assert.throws(() => accountIdentity({ ...cred1, accountId: "mismatch" }), PoolError);

  const dir = await mkdtemp(join(tmpdir(), "codex-test-1-"));
  try {
    const storePath = join(dir, "codex-accounts.json");
    const store = new AccountStore(storePath);

    // Initial empty read
    const initial = await store.read();
    assert.deepEqual(initial, { version: 1, accounts: [] });

    // Add first account
    const addedId1 = await store.add(cred1);
    assert.equal(addedId1, id1);
    let data = await store.read();
    assert.equal(data.accounts.length, 1);
    assert.equal(data.preferred, id1);

    // Add second account
    const addedId2 = await store.add(cred2);
    assert.equal(addedId2, id2);
    data = await store.read();
    assert.equal(data.accounts.length, 2);
    assert.equal(data.preferred, id1); // preferred stays first added

    // Duplicate login replacement with updated token
    const cred1Updated = makeCredential("user-1", "acc-aaa", "ref-updated", Date.now() + 7_200_000);
    const addedId1Again = await store.add(cred1Updated);
    assert.equal(addedId1Again, id1);
    data = await store.read();
    assert.equal(data.accounts.length, 2); // Still 2, not 3
    assert.equal(data.accounts.find((a) => a.id === id1)?.credential.refresh, "ref-updated");

    // Ambiguous prefixes / nonexistent
    await assert.rejects(store.manage("switch", "nonexistent"), PoolError);
    await assert.rejects(store.manage("switch", ""), PoolError);

    // Switch preferred account
    const switched = await store.manage("switch", id2.slice(0, 8));
    assert.equal(switched, id2);
    data = await store.read();
    assert.equal(data.preferred, id2);

    // Remove preferred account -> preferred updates to remaining account
    const removedId2 = await store.manage("remove", id2.slice(0, 8));
    assert.equal(removedId2, id2);
    data = await store.read();
    assert.equal(data.accounts.length, 1);
    assert.equal(data.preferred, id1);

    // Remove last account -> preferred becomes undefined
    const removedId1 = await store.manage("remove", id1.slice(0, 8));
    assert.equal(removedId1, id1);
    data = await store.read();
    assert.equal(data.accounts.length, 0);
    assert.equal(data.preferred, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("2. Private atomic persistence; reject malformed/insecure/symlink stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-test-2-"));
  try {
    const storePath = join(dir, "codex-accounts.json");
    const store = new AccountStore(storePath);
    const cred = makeCredential("user-sec", "acc-sec");

    await store.add(cred);

    // Verify 0600 file permissions on POSIX
    const stat = await lstat(storePath);
    assert.equal(stat.mode & 0o777, 0o600);

    // Reject insecure permissions (0644)
    await chmod(storePath, 0o644);
    await assert.rejects(store.read(), PoolError);
    await chmod(storePath, 0o600); // restore

    // Reject malformed JSON
    await writeFile(storePath, "not json content\n", { mode: 0o600 });
    await assert.rejects(store.read(), PoolError);

    // Reject invalid schema
    await writeFile(storePath, JSON.stringify({ version: 99, accounts: "invalid" }) + "\n", { mode: 0o600 });
    await assert.rejects(store.read(), PoolError);

    // Reject symlink store on read
    const validStorePath = join(dir, "valid-accounts.json");
    const validStore = new AccountStore(validStorePath);
    await validStore.add(cred);

    const symlinkPath = join(dir, "symlinked-accounts.json");
    await symlink(validStorePath, symlinkPath);
    const symlinkStore = new AccountStore(symlinkPath);
    await assert.rejects(symlinkStore.read(), PoolError);

    // Reject saving over a symlink
    await assert.rejects(symlinkStore.save({ version: 1, accounts: [] }), PoolError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("3. Two processes refresh once; rotated token survives concurrent updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-test-3-"));
  try {
    const storePath = join(dir, "codex-accounts.json");
    const store1 = new AccountStore(storePath);
    const store2 = new AccountStore(storePath);

    // Account with expired credential (expires in the past)
    const initialCred = makeCredential("user-rot", "acc-rot", "ref-initial", Date.now() - 1000);
    await store1.add(initialCred);

    let refreshCount = 0;
    const fakeOAuth: OAuthAuth = {
      name: "Fake Codex",
      isSubscription: true,
      login: async () => initialCred,
      refresh: async (credential) => {
        refreshCount += 1;
        // Verify only initial token was passed for exchange
        assert.equal(credential.refresh, "ref-initial");
        await sleep(35); // Contention window while lock is held
        return makeCredential("user-rot", "acc-rot", "ref-rotated", Date.now() + 3_600_000);
      },
      toAuth: async (c) => ({ apiKey: c.access }),
    };

    const native1 = { ...openaiCodexProvider(), auth: { ...openaiCodexProvider().auth, oauth: fakeOAuth } };
    const native2 = { ...openaiCodexProvider(), auth: { ...openaiCodexProvider().auth, oauth: fakeOAuth } };
    const pool1 = createCodexPool(store1, native1);
    const pool2 = createCodexPool(store2, native2);

    const mockFetch = async () => sseResponse([
      JSON.stringify({ type: "response.created", response: { id: "resp_ok" } }),
      JSON.stringify({ type: "response.completed", response: { id: "resp_ok", status: "completed" } }),
    ]);

    // Concurrently trigger streaming from both pools
    const [events1, events2] = await Promise.all([
      collectEvents(pool1.provider.streamSimple(dummyModel, makeContext(), { fetch: mockFetch, sessionId: "s1" })),
      collectEvents(pool2.provider.streamSimple(dummyModel, makeContext(), { fetch: mockFetch, sessionId: "s2" })),
    ]);

    assert.equal(events1.at(-1)?.type, "done");
    assert.equal(events2.at(-1)?.type, "done");

    // Exactly one refresh call across both pools!
    assert.equal(refreshCount, 1);

    // Verify rotated token is durably on disk with needsLogin cleared
    const onDisk = await store1.read();
    assert.equal(onDisk.accounts[0]?.credential.refresh, "ref-rotated");
    assert.equal(onDisk.accounts[0]?.needsLogin, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("4. Refresh abort/crash/save failure fails closed; lock waiting honors abort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-test-4-"));
  try {
    const storePath = join(dir, "codex-accounts.json");
    const store = new AccountStore(storePath);

    const expiredCred = makeCredential("user-fail", "acc-fail", "ref-fail", Date.now() - 1000);
    await store.add(expiredCred);

    // Refresh throws network/exchange error
    const failingOAuth: OAuthAuth = {
      name: "Fake Codex",
      isSubscription: true,
      login: async () => expiredCred,
      refresh: async () => {
        throw new Error("Token refresh exchange failure");
      },
      toAuth: async (c) => ({ apiKey: c.access }),
    };

    const pool = createCodexPool(store, {
      ...openaiCodexProvider(),
      auth: { ...openaiCodexProvider().auth, oauth: failingOAuth },
    });

    const events = await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), { sessionId: "s" }));
    assert.equal(events.at(-1)?.type, "error");

    // The account on disk MUST now have needsLogin: true (fail closed)
    const onDisk = await store.read();
    assert.equal(onDisk.accounts[0]?.needsLogin, true);

    // Subsequent attempts to select immediately fail without re-refreshing
    const retryEvents = await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), { sessionId: "s" }));
    assert.equal(retryEvents.at(-1)?.type, "error");
    const retryError = retryEvents.at(-1) as { error: { errorMessage: string } };
    assert.match(retryError.error.errorMessage, /Codex pool exhausted/);

    // Lock waiting honors abort signal
    const lockDir = `${storePath}.lock`;
    await mkdir(lockDir, { mode: 0o700 });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);

    await assert.rejects(
      store.update(async () => "done", controller.signal),
      (err: Error) => err.name === "AbortError",
    );

    // Lock directory must NOT have been stolen or deleted by the aborted process
    const stat = await lstat(lockDir);
    assert.equal(stat.isDirectory(), true);

    await rm(lockDir, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("5. Actual native adapter with synthetic JWTs and mocked HTTP/SSE", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-test-5-"));
  try {
    const storePath = join(dir, "codex-accounts.json");
    const store = new AccountStore(storePath);
    await store.add(makeCredential("user-native", "acc-native"));

    const pool = createCodexPool(store, openaiCodexProvider());

    // 5A: Text streaming SSE
    const textFetch = async () => sseResponse([
      JSON.stringify({ type: "response.created", response: { id: "resp_text" } }),
      JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } }),
      JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "Hello" }),
      JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: " world" }),
      JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", content: [{ type: "output_text", text: "Hello world" }] } }),
      JSON.stringify({ type: "response.completed", response: { id: "resp_text", status: "completed", usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } }),
    ]);

    const textEvents = await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), { fetch: textFetch }));
    const types = textEvents.map((e) => e.type);
    assert.ok(types.includes("start"));
    assert.ok(types.includes("text_start"));
    assert.ok(types.includes("text_delta"));
    assert.ok(types.includes("text_end"));
    assert.ok(types.includes("done"));

    const terminal = textEvents.at(-1) as { message: { provider: string; usage: { totalTokens: number } } };
    assert.equal(terminal.message.provider, PROVIDER_ID);
    assert.equal(terminal.message.usage.totalTokens, 20);

    // 5B: Tool call SSE
    const toolFetch = async () => sseResponse([
      JSON.stringify({ type: "response.created", response: { id: "resp_tool" } }),
      JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_abc", id: "fc_1", name: "read", arguments: "" } }),
      JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"path\":" }),
      JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: "\"test.txt\"}" }),
      JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_abc", id: "fc_1", name: "read", arguments: "{\"path\":\"test.txt\"}" } }),
      JSON.stringify({ type: "response.completed", response: { id: "resp_tool", status: "completed" } }),
    ]);

    const toolEvents = await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), { fetch: toolFetch }));
    const toolTypes = toolEvents.map((e) => e.type);
    assert.ok(toolTypes.includes("toolcall_start"));
    assert.ok(toolTypes.includes("toolcall_delta"));
    assert.ok(toolTypes.includes("toolcall_end"));
    assert.ok(toolTypes.includes("done"));

    // 5C: Transcript round-trip translates provider ID to openai-codex
    let capturedPayload: any;
    const prevMessage = {
      role: "assistant" as const,
      provider: PROVIDER_ID,
      api: "openai-codex-responses",
      model: dummyModel.id,
      timestamp: Date.now(),
      content: [{ type: "text" as const, text: "Previous answer" }],
      stopReason: "stop" as const,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };

    const emptyFetch = async () => sseResponse([
      JSON.stringify({ type: "response.created", response: { id: "resp_empty" } }),
      JSON.stringify({ type: "response.completed", response: { id: "resp_empty", status: "completed" } }),
    ]);

    await collectEvents(pool.provider.streamSimple(dummyModel, makeContext([prevMessage]), {
      onPayload: (payload) => { capturedPayload = payload; },
      fetch: emptyFetch,
    }));
    assert.ok(capturedPayload?.input?.some((item: any) => item.content?.[0]?.text === "Previous answer"));

    // 5D: Empty completion
    const emptyEvents = await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), { fetch: emptyFetch }));
    assert.equal(emptyEvents.at(-1)?.type, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("6. Pre-output quota/auth failover; reset-header/date/body parsing; exhaustion bounded by account count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-test-6-"));
  try {
    const storePath = join(dir, "codex-accounts.json");
    const store = new AccountStore(storePath);

    const credA = makeCredential("user-A", "acc-A");
    const credB = makeCredential("user-B", "acc-B");
    await store.add(credA);
    await store.add(credB);

    const pool = createCodexPool(store, openaiCodexProvider());

    // 6A: Failover on 429: Account A fails with 429 + Retry-After: 45, Account B succeeds
    const attempts: string[] = [];
    const failoverFetch = async (_input: unknown, init?: RequestInit) => {
      const authHeader = new Headers(init?.headers).get("Authorization") ?? "";
      attempts.push(authHeader);
      if (authHeader.includes(credA.access)) {
        return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Quota hit" } }), {
          status: 429,
          headers: { "Retry-After": "45" },
        });
      }
      return sseResponse([
        JSON.stringify({ type: "response.created", response: { id: "resp_b" } }),
        JSON.stringify({ type: "response.completed", response: { id: "resp_b", status: "completed" } }),
      ]);
    };

    const events = await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), { fetch: failoverFetch }));
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(attempts.length, 2);

    // Account A is placed on cooldown on disk
    const dataAfterFailover = await store.read();
    const accA = dataAfterFailover.accounts.find((a) => a.id === accountIdentity(credA));
    assert.ok((accA?.cooldownUntil ?? 0) >= Date.now() + 40_000);

    // 6B: Cooldown calculation tests
    const now = 1_700_000_000_000;
    assert.equal(cooldownUntil(new Headers({ "retry-after-ms": "5000" }), undefined, now), now + 5000);
    assert.equal(cooldownUntil(new Headers({ "retry-after": "120" }), undefined, now), now + 120_000);
    assert.equal(cooldownUntil(new Headers({ "retry-after": "Sun, 01 Jan 2030 00:00:00 GMT" }), undefined, now), Date.parse("Sun, 01 Jan 2030 00:00:00 GMT"));
    assert.equal(cooldownUntil(new Headers(), 1_750_000_000, now), 1_750_000_000_000);
    assert.equal(cooldownUntil(new Headers(), undefined, now), now + 60_000); // default 60s

    // 6C: Exhaustion bounded by account count
    const exhaustedFetch = async () => new Response(JSON.stringify({ error: { code: "usage_limit_reached" } }), {
      status: 429,
      headers: { "Retry-After": "30" },
    });

    const exhaustEvents = await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), { fetch: exhaustedFetch }));
    const lastEvent = exhaustEvents.at(-1) as { error: { errorMessage: string; diagnostics?: Array<{ type: string; details?: unknown }> } };
    assert.equal(lastEvent.error.errorMessage.includes("Codex pool exhausted"), true);
    assert.equal(lastEvent.error.diagnostics?.[0]?.type, "codex_pool_exhausted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("7. No replay after text, thinking, or tool output; generic/network/context errors do not trigger account hopping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-test-7-"));
  try {
    const storePath = join(dir, "codex-accounts.json");
    const store = new AccountStore(storePath);

    const cred1 = makeCredential("user-rep1", "acc-rep1");
    const cred2 = makeCredential("user-rep2", "acc-rep2");
    await store.add(cred1);
    await store.add(cred2);

    const pool = createCodexPool(store, openaiCodexProvider());

    // 7A: Error after text delta MUST suppress replay and never call account 2
    let account2Calls = 0;
    const interruptedFetch = async (_input: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      if (auth.includes(cred2.access)) {
        account2Calls += 1;
      }
      // Emit output_text.delta, then simulate stream failure (HTTP 429 mid-stream)
      return sseResponse([
        JSON.stringify({ type: "response.created", response: { id: "resp_mid" } }),
        JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_mid" } }),
        JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "Partial text here..." }),
        JSON.stringify({ type: "response.failed", response: { error: { code: "usage_limit_reached", message: "Hit limit" } } }),
      ]);
    };

    const interruptedEvents = await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), { fetch: interruptedFetch }));
    const errorEv = interruptedEvents.at(-1) as { error: { errorMessage: string; stopReason: string } };
    assert.equal(errorEv.error.stopReason, "error");
    assert.equal(errorEv.error.errorMessage, "Codex response interrupted after output; automatic replay suppressed.");
    assert.equal(account2Calls, 0); // Account 2 was NEVER called!

    // Fresh store for 7B and 7C so cooldowns from 7A don't affect initial account availability
    const store7B = new AccountStore(join(dir, "codex-accounts-7b.json"));
    await store7B.add(cred1);
    await store7B.add(cred2);
    const pool7B = createCodexPool(store7B, openaiCodexProvider());

    // 7B: Generic 500 error before output does NOT hop accounts
    let genericAcc2Calls = 0;
    const error500Fetch = async (_input: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      if (auth.includes(cred2.access)) genericAcc2Calls += 1;
      return new Response("Internal Server Error", { status: 500 });
    };

    const events500 = await collectEvents(pool7B.provider.streamSimple(dummyModel, makeContext(), { fetch: error500Fetch }));
    const ev500 = events500.at(-1) as { error: { errorMessage: string } };
    assert.equal(ev500.error.errorMessage, "Codex request failed; no account replay performed.");
    assert.equal(genericAcc2Calls, 0);

    // 7C: Context length exceeded does not hop accounts
    const contextOverflowFetch = async () => new Response(JSON.stringify({
      error: { code: "context_length_exceeded", message: "maximum context length exceeded" },
    }), { status: 400 });

    const contextEvents = await collectEvents(pool7B.provider.streamSimple(dummyModel, makeContext(), { fetch: contextOverflowFetch }));
    const evCtx = contextEvents.at(-1) as { error: { errorMessage: string } };
    assert.equal(evCtx.error.errorMessage, "context_length_exceeded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("8. Abort before selection, during refresh, response-body read, and streaming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-test-8-"));
  try {
    const storePath = join(dir, "codex-accounts.json");
    const store = new AccountStore(storePath);
    await store.add(makeCredential("user-ab", "acc-ab"));

    const pool = createCodexPool(store, openaiCodexProvider());

    // 8A: Abort before selection
    const preAborted = new AbortController();
    preAborted.abort();
    const preEvents = await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), { signal: preAborted.signal }));
    const lastPre = preEvents.at(-1) as { error: { stopReason: string; errorMessage: string } };
    assert.equal(lastPre.error.stopReason, "aborted");
    assert.equal(lastPre.error.errorMessage, "Codex request cancelled.");

    // 8B: Abort during streaming
    const streamController = new AbortController();
    const abortingFetch = async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "r1" } })}\n\n`));
          setTimeout(() => {
            streamController.abort();
          }, 20);
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    };

    const streamEvents = await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), {
      fetch: abortingFetch,
      signal: streamController.signal,
    }));
    const lastStream = streamEvents.at(-1) as { error: { stopReason: string } };
    assert.equal(lastStream.error.stopReason, "aborted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("account commands reject the login alias and retain add and native OAuth", async () => {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let provider: Provider | undefined;
  codexPoolExtension({
    registerProvider: (registered: Provider) => { provider = registered; },
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
  } as unknown as ExtensionAPI);
  assert.ok(handler);
  assert.equal(provider?.id, PROVIDER_ID);
  assert.equal(typeof provider?.auth.oauth?.login, "function");
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message: string) => { messages.push(message); };
  try {
    const ctx = { hasUI: false } as ExtensionCommandContext;
    for (const args of ["login", "login extra", "add extra", "unknown"]) {
      await handler(args, ctx);
      assert.equal(messages.pop(), "Usage: /codex-pool.accounts list|add|switch <id>|remove <id>");
    }
    await handler("add", ctx);
    assert.equal(messages.pop(), "Use /login codex-pool in an interactive Pi session to add accounts.");
  } finally {
    console.error = originalError;
  }
});

test("9. Browser-success prompt cancellation versus genuine user cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-test-9-"));
  try {
    const store = new AccountStore(join(dir, "codex-accounts.json"));

    // Capture interaction handler registered by codexPoolExtension
    let commandHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const fakePi = {
      registerProvider: () => {},
      registerCommand: (_name: string, def: { handler: typeof commandHandler }) => {
        commandHandler = def.handler;
      },
    } as unknown as ExtensionAPI;

    codexPoolExtension(fakePi);
    assert.ok(commandHandler);

    // 9A: Browser-success scenario:
    // SDK aborts the manual code prompt (via prompt.signal) when callback succeeds.
    // The prompt must NOT abort parent login flow.
    const manualAbort = new AbortController();
    let loginInterrupted = false;

    const fakeSdkOAuth: OAuthAuth = {
      name: "OpenAI Codex",
      isSubscription: true,
      login: async (interaction: ProviderAuthInteraction) => {
        // SDK spawns manual code prompt
        const promptPromise = interaction.prompt({
          type: "manual_code",
          message: "Enter code",
          signal: manualAbort.signal,
        });

        // Simulate browser callback succeeding: SDK aborts manual prompt
        manualAbort.abort();

        // SDK races callback result with manual prompt
        await Promise.race([
          Promise.resolve(),
          promptPromise,
        ]);

        // Check if parent interaction signal was erroneously aborted
        if (interaction.signal.aborted) {
          loginInterrupted = true;
          throw new Error("Parent login was aborted!");
        }

        return makeCredential("user-oauth-success", "acc-oauth-success");
      },
      refresh: async (c) => c,
      toAuth: async (c) => ({ apiKey: c.access }),
    };

    // Replace native with fakeSdkOAuth
    const customPool = createCodexPool(store, {
      ...openaiCodexProvider(),
      auth: { ...openaiCodexProvider().auth, oauth: fakeSdkOAuth },
    });

    // Run customPool.add with mock interaction
    const ctxSuccess = {
      hasUI: true,
      ui: {
        notify: () => {},
        input: async (_msg: string, _ph?: string, opts?: { signal?: AbortSignal }) => {
          // When signal aborts, UI input returns undefined
          if (opts?.signal?.aborted) return undefined;
          return new Promise<string | undefined>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          });
        },
        select: async () => undefined,
      },
    } as unknown as ExtensionCommandContext;

    // We can directly test pool.add
    const addedId = await customPool.add({
      signal: new AbortController().signal,
      notify: () => {},
      prompt: async (prompt) => {
        // Simulate index.ts interaction() behavior
        const opts = { signal: prompt.signal };
        const placeholder = prompt.type === "select" ? undefined : prompt.placeholder;
        const val = await ctxSuccess.ui.input(prompt.message, placeholder, opts);
        if (val === undefined) {
          if (prompt.signal?.aborted) {
            return new Promise<string>(() => {});
          }
          throw new PoolError("Codex login cancelled.");
        }
        return val;
      },
    });

    assert.ok(addedId);
    assert.equal(loginInterrupted, false);

    // 9B: Genuine user cancellation scenario:
    // User dismisses/cancels the prompt (prompt.signal is NOT aborted)
    const ctxUserCancel = {
      hasUI: true,
      ui: {
        notify: () => {},
        input: async () => undefined, // User pressed Esc
      },
    } as unknown as ExtensionCommandContext;

    const fakeSdkOAuthCancel: OAuthAuth = {
      name: "OpenAI Codex",
      isSubscription: true,
      login: async (interaction: ProviderAuthInteraction) => {
        await interaction.prompt({
          type: "manual_code",
          message: "Enter code",
        });
        return makeCredential("should-not", "reach-here");
      },
      refresh: async (c) => c,
      toAuth: async (c) => ({ apiKey: c.access }),
    };

    const cancelPool = createCodexPool(store, {
      ...openaiCodexProvider(),
      auth: { ...openaiCodexProvider().auth, oauth: fakeSdkOAuthCancel },
    });

    await assert.rejects(
      cancelPool.add({
        signal: new AbortController().signal,
        notify: () => {},
        prompt: async (prompt) => {
          const placeholder = prompt.type === "select" ? undefined : prompt.placeholder;
          const val = await ctxUserCancel.ui.input(prompt.message, placeholder);
          if (val === undefined) {
            if (prompt.signal?.aborted) return new Promise<string>(() => {});
            throw new PoolError("Codex login cancelled.");
          }
          return val;
        },
      }),
      (err: Error) => err.message === "Codex login cancelled.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("10. Registration/auth availability and sanitized failures, including Pi retry classification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-test-10-"));
  try {
    const storePath = join(dir, "codex-accounts.json");
    const store = new AccountStore(storePath);
    const pool = createCodexPool(store, openaiCodexProvider());

    const authInput = {
      ctx: defaultProviderAuthContext(),
      signal: new AbortController().signal,
    };

    // 10A: Auth check reports undefined when pool is empty
    const initialCheck = await pool.provider.auth.apiKey?.check?.(authInput);
    assert.equal(initialCheck, undefined);

    // After adding an account, auth check reports configured
    await store.add(makeCredential("user-reg", "acc-reg"));
    const populatedCheck = await pool.provider.auth.apiKey?.check?.(authInput);
    assert.deepEqual(populatedCheck, { source: "Codex pool", type: "oauth" });

    const resolveAuth = await pool.provider.auth.apiKey?.resolve?.(authInput);
    assert.deepEqual(resolveAuth, { auth: { apiKey: "codex-pool-managed" }, source: "OAuth" });

    // Models registration
    const models = pool.provider.getModels();
    assert.ok(models.length > 0);
    assert.equal(models[0].provider, PROVIDER_ID);

    // 10B: Retry classification with isRetryableAssistantError
    assert.equal(isRetryableAssistantError(makeErrorMessage(
      "Codex pool exhausted: accounts need login or are cooling down. Use /codex-pool.accounts list.",
    )), false);

    assert.equal(isRetryableAssistantError(makeErrorMessage(
      "Codex pool exhausted: accounts need login or are cooling down (earliest reset in ~45s). Use /codex-pool.accounts list.",
    )), false);

    assert.equal(isRetryableAssistantError(makeErrorMessage(
      "Codex response interrupted after output; automatic replay suppressed.",
    )), false);

    assert.equal(isRetryableAssistantError(makeErrorMessage(
      "Codex request failed; no account replay performed.",
    )), false);

    assert.equal(isRetryableAssistantError(makeErrorMessage(
      "context_length_exceeded",
    )), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("11. P1: Forwarded partial events are isolated snapshots; secrets do not escape to delayed consumers or during persistence contention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-test-11-"));
  try {
    const storePath = join(dir, "codex-accounts.json");
    const store = new AccountStore(storePath);

    const cred = makeCredential("user-p1", "acc-p1");
    await store.add(cred);

    // Inject artificial persistence delay into store.update to test the contention window
    const originalUpdate = store.update.bind(store);
    store.update = async (fn, signal) => {
      return originalUpdate(async (data) => {
        await sleep(80);
        return fn(data);
      }, signal);
    };

    const pool = createCodexPool(store, openaiCodexProvider());

    const secret = "synthetic-secret-token-p1-exposed-98765";
    const secretFetch = async () => sseResponse([
      JSON.stringify({ type: "response.created", response: { id: "resp_p1" } }),
      JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_p1" } }),
      JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "Meaningful output committed" }),
      JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded", message: `Upstream error leaking: ${secret}` } }),
    ]);

    const capturedEvents: AssistantMessageEvent[] = [];
    let polledLeak: string | undefined;
    let pollInterval: NodeJS.Timeout | undefined;

    const stream = pool.provider.streamSimple(dummyModel, makeContext(), { fetch: secretFetch });

    // Poll the partial objects of already-emitted events during persistence contention
    pollInterval = setInterval(() => {
      for (const ev of capturedEvents) {
        if ("partial" in ev) {
          const errMsg = ev.partial.errorMessage;
          if (typeof errMsg === "string" && errMsg.includes(secret)) {
            polledLeak = errMsg;
          }
        }
      }
    }, 10);

    try {
      for await (const event of stream) {
        capturedEvents.push(event);
      }
    } finally {
      clearInterval(pollInterval);
    }

    // 1. Persistence contention check: secret was NEVER observed on any partial event
    assert.equal(polledLeak, undefined);

    // 2. Event type assertions
    const startEvent = capturedEvents.find((e) => e.type === "start");
    const textStartEvent = capturedEvents.find((e) => e.type === "text_start");
    const textDeltaEvent = capturedEvents.find((e) => e.type === "text_delta");
    const errorEvent = capturedEvents.find((e) => e.type === "error");

    assert.ok(startEvent && "partial" in startEvent);
    assert.ok(textStartEvent && "partial" in textStartEvent);
    assert.ok(textDeltaEvent && "partial" in textDeltaEvent);
    assert.ok(errorEvent && errorEvent.type === "error");

    // 3. Delayed consumer checks: inspect snapshots after completion
    assert.equal(startEvent.partial.errorMessage, undefined);
    assert.equal(textStartEvent.partial.errorMessage, undefined);
    assert.equal(textDeltaEvent.partial.errorMessage, undefined);

    assert.equal(startEvent.partial.provider, PROVIDER_ID);
    assert.equal(textStartEvent.partial.provider, PROVIDER_ID);
    assert.equal(textDeltaEvent.partial.provider, PROVIDER_ID);

    // 4. Distinct object identities (snapshots are isolated from each other)
    assert.notEqual(startEvent.partial, textStartEvent.partial);
    assert.notEqual(textStartEvent.partial, textDeltaEvent.partial);

    // 5. Final error event contains sanitized replay suppression message, not upstream secret
    assert.equal(errorEvent.error.errorMessage, "Codex response interrupted after output; automatic replay suppressed.");
    assert.equal(errorEvent.error.provider, PROVIDER_ID);
    assert.equal(errorEvent.error.errorMessage.includes(secret), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent quota responses cannot shorten a credential cooldown", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".codex-cooldown-"));
  try {
    const store = new AccountStore(join(dir, "accounts.json"));
    await store.add(makeCredential("concurrent", "cooldown"));
    const pool = createCodexPool(store);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const short = collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), {
      fetch: async () => {
        entered();
        await released;
        return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
      },
    }));
    await started;
    await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), {
      fetch: async () => new Response("{}", { status: 429, headers: { "retry-after": "3600" } }),
    }));
    const deadline = (await store.read()).accounts[0].cooldownUntil!;
    release();
    const events = await short;
    assert.equal((await store.read()).accounts[0].cooldownUntil, deadline);
    const last = events.at(-1);
    assert.ok(last?.type === "error");
    assert.match(last.error.errorMessage!, /~60m/);
    let calls = 0;
    await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), {
      fetch: async () => { calls++; return new Response("{}", { status: 500 }); },
    }));
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stream snapshots share completed blocks and isolate growing tool arguments", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".codex-snapshots-"));
  try {
    const store = new AccountStore(join(dir, "accounts.json"));
    await store.add(makeCredential("snapshots", "snapshots"));
    for (const method of ["stream", "streamSimple"] as const) {
      const pool = createCodexPool(store);
      const text = "x".repeat(64_000);
      const events = await collectEvents(pool.provider[method](dummyModel, makeContext(), {
        fetch: async () => new Response(new ReadableStream({
          async start(controller) {
            const lines = [
              JSON.stringify({ type: "response.created", response: { id: "resp_snap" } }),
              JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_snap" } }),
              JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: text }),
              JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_snap", content: [{ type: "output_text", text }] } }),
              JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_snap", call_id: "call_snap", name: "write", arguments: "" } }),
              JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"text":"' + text }),
              JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 1, delta: 'tail"}' }),
              JSON.stringify({ type: "error", error: { code: "server_error", message: "secret-snapshot-error" } }),
            ];
            for (const line of lines) {
              controller.enqueue(new TextEncoder().encode(`data: ${line}\n\n`));
              await sleep(5);
            }
            controller.close();
          }
        }), { headers: { "Content-Type": "text/event-stream" } }),
      }));
      const deltas = events.filter((event) => event.type === "toolcall_delta");
      assert.equal(deltas.length, 2);
      assert.equal(deltas[0].partial.content[0], deltas[1].partial.content[0]);
      const first = deltas[0].partial.content[1];
      const second = deltas[1].partial.content[1];
      assert.ok(first.type === "toolCall" && second.type === "toolCall");
      assert.equal(first.arguments.text, text);
      assert.equal(second.arguments.text, text + "tail");
      assert.equal("partialJson" in first, false);
      assert.equal("customInput" in first, false);
      for (const event of events) {
        if ("partial" in event) {
          assert.equal(event.partial.errorMessage, undefined);
          assert.equal(event.partial.diagnostics, undefined);
        }
      }
      assert.equal(JSON.stringify(events).includes("secret-snapshot-error"), false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("12. P2: Multiline SSE quota error triggers failover and cooldown on SDK 0.87.1 streamSimple", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-test-12-"));
  try {
    const storePath = join(dir, "codex-accounts.json");
    const store = new AccountStore(storePath);

    const credA = makeCredential("user-p2-A", "acc-p2-A");
    const credB = makeCredential("user-p2-B", "acc-p2-B");
    await store.add(credA);
    await store.add(credB);

    const pool = createCodexPool(store, openaiCodexProvider());

    const attempts: string[] = [];
    const resetsAtUnix = 1_850_000_000;

    // Multiline SSE event with multiple data: lines (pretty-printed JSON) and CRLF line endings
    const multilineSSE = [
      "data: {",
      'data:   "type": "response.failed",',
      'data:   "response": {',
      'data:     "error": {',
      'data:       "code": "rate_limit_exceeded",',
      'data:       "message": "The quota has been exceeded for this account",',
      `data:       "resets_at": ${resetsAtUnix}`,
      "data:     }",
      "data:   }",
      "data: }",
      "",
      "",
    ].join("\r\n");

    const multiFetch = async (_input: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      attempts.push(auth);

      if (auth.includes(credA.access)) {
        // Return 200 with multiline SSE delivered in chunked streams
        const chunks = [
          multilineSSE.slice(0, 35),
          multilineSSE.slice(35, 90),
          multilineSSE.slice(90),
        ];
        const stream = new ReadableStream({
          async start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(new TextEncoder().encode(chunk));
              await sleep(5);
            }
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      // Account B succeeds
      return sseResponse([
        JSON.stringify({ type: "response.created", response: { id: "resp_p2_b" } }),
        JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_p2_b" } }),
        JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "Account B answered successfully" }),
        JSON.stringify({ type: "response.completed", response: { id: "resp_p2_b", status: "completed" } }),
      ]);
    };

    // Use streamSimple directly (on SDK 0.87.1 this exercises the tap without onProviderStreamEvent)
    const events = await collectEvents(pool.provider.streamSimple(dummyModel, makeContext(), { fetch: multiFetch }));

    // Request must failover to Account B and succeed with done
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(attempts.length, 2);

    // Account A was placed on cooldown on disk using the resets_at timestamp from the multiline SSE frame
    const dataOnDisk = await store.read();
    const accA = dataOnDisk.accounts.find((a) => a.id === accountIdentity(credA));
    assert.ok(accA);
    assert.equal(accA.cooldownUntil, resetsAtUnix * 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
