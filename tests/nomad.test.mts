import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeContext } from '@earendil-works/pi-ai';
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import nomad from '../extensions/nomad/index.ts';

function setup() {
  let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const api = new Proxy(
    {},
    {
      get(_target, key) {
        assert.equal(
          key,
          'registerCommand',
          `Nomad must not override provider/auth/catalog or spawn a gateway: ${String(key)}`,
        );
        return (name: string, command: { handler: typeof handler }) => {
          assert.equal(name, 'opencode');
          handler = command.handler;
        };
      },
    },
  ) as ExtensionAPI;
  nomad(api);
  return async (args: string) => {
    let message = '';
    await handler(args, {
      ui: {
        notify: (text: string) => {
          message = text;
        },
      },
    } as ExtensionCommandContext);
    return message;
  };
}

test('Nomad leaves built-in catalog/auth/streaming intact and rejects rotation', async () => {
  const run = setup();
  assert.match(await run('status'), /built-in OpenCode provider/);
  assert.match(await run(''), /429/);
  assert.match(await run('rotate'), /cannot renew an upstream quota/);
  assert.match(await run('unknown'), /Usage:/);
});

const provider = opencodeProvider();
const source = provider.getModels().find((m) => m.api === 'openai-completions');
assert.ok(source);
const model = { ...source, id: 'test-model', baseUrl: 'http://localhost/v1' };
const context = normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 0 }] });

function response(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('built-in OpenCode streams text and result() collects it without a gateway', async () => {
  setup();
  const fetch = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.equal(body.messages.filter((m: { role: string }) => m.role === 'system').length, 0);
    assert.equal(body.tools?.length ?? 0, 0);
    return response([
      { choices: [{ delta: { content: 'hel' } }] },
      { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ]);
  };
  const stream = provider.streamSimple(model, context, { apiKey: 'test-key', fetch });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.ok(events.some((event) => event.type === 'text_delta'));
  const result = await stream.result();
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(result.content, [{ type: 'text', text: 'hello' }]);
  assert.equal(result.usage.totalTokens, 3);
  const complete = await provider.streamSimple(model, context, { apiKey: 'test-key', fetch }).result();
  assert.deepEqual(complete.content, result.content);
});

test('built-in OpenCode preserves fragmented tool calls', async () => {
  const result = await provider
    .streamSimple(model, context, {
      apiKey: 'test-key',
      fetch: async () =>
        response([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"pa' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
    })
    .result();
  assert.equal(result.stopReason, 'toolUse');
  const call = result.content.find((block) => block.type === 'toolCall');
  assert.ok(call && call.type === 'toolCall');
  assert.equal(call.name, 'read');
  assert.deepEqual(call.arguments, { path: 'a.txt' });
});

test('quota 429 is preserved with one request, no local rotation/retry', async () => {
  let requests = 0;
  const result = await provider
    .streamSimple(model, context, {
      apiKey: 'test-key',
      maxRetries: 0,
      fetch: async () => {
        requests++;
        return Response.json(
          { error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached' } },
          { status: 429 },
        );
      },
    })
    .result();
  assert.equal(requests, 1);
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage ?? '', /Free usage limit reached/);
});
