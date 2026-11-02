import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { GeminiWebError, decodeReply } from '../extensions/gemini-web/protocol.ts';

const idTool: Tool = {
  name: 'lookup',
  description: 'Look up records by id',
  parameters: Type.Object({
    ids: Type.Array(Type.Number()),
    limit: Type.Optional(Type.Number()),
    note: Type.Optional(Type.String()),
  }),
};

function call(tool: Tool, args: Record<string, unknown>) {
  const text = JSON.stringify({ tool_calls: [{ name: tool.name, arguments: args }] });
  const decoded = decodeReply(text, [tool], 'g');
  assert.equal(decoded.toolCalls.length, 1);
  return decoded.toolCalls[0].arguments as Record<string, unknown>;
}

test('decodeReply: pi 1.5.0 coercion turns a numeric string into a number', () => {
  assert.equal(call(idTool, { ids: [1], limit: '7' }).limit, 7);
});

test('decodeReply: pi 1.5.0 coercion wraps a single value into a one-item array', () => {
  assert.deepEqual(call(idTool, { ids: 3 }).ids, [3]);
  assert.deepEqual(call(idTool, { ids: '3' }).ids, [3]);
});

test('decodeReply: a genuine type mismatch still rejects the tool call', () => {
  assert.throws(
    () => call(idTool, { ids: { a: 1 } }),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'tools',
  );
});

test('decodeReply: null is dropped from an optional non-nullable property', () => {
  assert.equal('note' in call(idTool, { ids: [1], note: null }), false);
});

test('decodeReply: an explicit null survives where the schema declares null', () => {
  const nullable: Tool = {
    name: 'budget',
    description: 'Set or clear a budget',
    parameters: Type.Object({
      token_budget: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
    }),
  };
  assert.equal(call(nullable, { token_budget: null }).token_budget, null);
});
