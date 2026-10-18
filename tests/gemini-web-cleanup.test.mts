import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeminiWebClient } from '../extensions/gemini-web/client.ts';
import {
  GeminiWebError,
  parseWebThinkingLevel,
  validateWebThinkingLevel,
  type WebModel,
} from '../extensions/gemini-web/protocol.ts';

test('validateWebThinkingLevel: strict Pi/client validator enforces canonical low/medium/high and low default', () => {
  // Undefined defaults to 'low'
  assert.equal(validateWebThinkingLevel(), 'low');
  assert.equal(validateWebThinkingLevel(undefined), 'low');

  // Exact canonical levels pass through
  assert.equal(validateWebThinkingLevel('low'), 'low');
  assert.equal(validateWebThinkingLevel('medium'), 'medium');
  assert.equal(validateWebThinkingLevel('high'), 'high');

  // Strict rejection: empty string, whitespace, non-canonical casing must fail before I/O
  const nonCanonicalCases = ['', ' ', '   ', 'low ', ' low', ' LOW ', 'LOW', 'Low', 'Medium', 'HIGH', ' High '];
  for (const val of nonCanonicalCases) {
    assert.throws(
      () => validateWebThinkingLevel(val as any),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'unsupported',
      `Expected "${val}" to be rejected by strict validator`,
    );
  }

  // Strict rejection of unsupported level names and non-string untyped values
  const invalidCases = [
    'off',
    'minimal',
    'xhigh',
    'max',
    'unknown',
    'none',
    null,
    123,
    0,
    true,
    false,
    {},
    [],
    Symbol('thinking'),
  ];
  for (const val of invalidCases) {
    assert.throws(
      () => validateWebThinkingLevel(val as any),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'unsupported',
      `Expected ${String(val)} to be rejected by strict validator`,
    );
  }
});

test('parseWebThinkingLevel: builder encoder normalizes string levels and encodes to wire values 1/4/2', () => {
  // Preserve the original undefined/empty default; whitespace alone is invalid.
  assert.equal(parseWebThinkingLevel(), 1);
  assert.equal(parseWebThinkingLevel(undefined), 1);
  assert.equal(parseWebThinkingLevel(''), 1);

  // Canonical and case/whitespace-normalized names encode correctly
  assert.equal(parseWebThinkingLevel('low'), 1);
  assert.equal(parseWebThinkingLevel('LOW'), 1);
  assert.equal(parseWebThinkingLevel('  low  '), 1);

  assert.equal(parseWebThinkingLevel('medium'), 4);
  assert.equal(parseWebThinkingLevel('Medium'), 4);
  assert.equal(parseWebThinkingLevel('  medium  '), 4);

  assert.equal(parseWebThinkingLevel('high'), 2);
  assert.equal(parseWebThinkingLevel('HIGH'), 2);
  assert.equal(parseWebThinkingLevel('  High  '), 2);

  // Unsupported level names and non-string untyped values fail safely
  const invalidCases = [' ', '   ', 'off', 'minimal', 'xhigh', 'max', 'unknown', 'none', null, 123, true, {}, []];
  for (const val of invalidCases) {
    assert.throws(
      () => parseWebThinkingLevel(val as any),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'unsupported',
      `Expected ${String(val)} to be rejected by encoder`,
    );
  }
});

test('GeminiWebClient: client thinking level rejects non-canonical values before network, and response helper cancels body on error', async () => {
  const model: WebModel = {
    id: 'models/gemini-cleanup-test',
    name: 'Gemini Cleanup Test',
    capacity: 1,
    capacityField: 13,
    modelNumber: 1,
  };
  const mockStore = {
    read: async () => ({
      version: 1 as const,
      revision: 'rev-cleanup',
      cookieHeader: '__Secure-1PSID=psid; __Secure-1PSIDTS=ts',
      authUser: 0,
      updatedAt: 1000,
      models: [model],
    }),
    save: async () => {},
  };

  let networkCalls = 0;
  let bodyCancelled = false;
  const mockFetch: typeof globalThis.fetch = async () => {
    networkCalls++;
    const stream = new ReadableStream({
      cancel() {
        bodyCancelled = true;
      },
    });
    return new Response(stream, { status: 302, headers: { location: 'https://accounts.google.com' } });
  };

  const client = createGeminiWebClient(mockStore as any, { fetch: mockFetch });

  // 1. Strict thinking level validation prevents network call on non-canonical / unsupported values
  await assert.rejects(
    client.generate(model.id, { prompt: 'hi' }, { thinkingLevel: ' LOW ' as any }),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'unsupported',
  );
  await assert.rejects(
    client.generate(model.id, { prompt: 'hi' }, { thinkingLevel: '' as any }),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'unsupported',
  );
  assert.equal(networkCalls, 0, 'Strict validator must reject before network I/O');

  // 2. Response helper cancels response body when status is non-200 redirect
  await assert.rejects(
    client.generate(model.id, { prompt: 'hi' }),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'auth',
  );
  assert.equal(networkCalls, 1);
  assert.equal(bodyCancelled, true, 'Response helper must cancel response body on error status');

  client.close();
});
