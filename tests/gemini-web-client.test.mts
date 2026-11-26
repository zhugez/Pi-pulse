// Adapted from gemini-web-to-api (https://github.com/ntthanh2603/gemini-web-to-api)
// Pinned upstream commit: 1f1577dbd479d5b61a1c5f03de742ffcdeb51f6d
// Copyright (c) 2025 Nguyễn Tuấn Thành
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CookieCredentialStore,
  parseCookieImport,
  readCookieImport,
  type CookieCredential,
} from '../extensions/gemini-web/auth.ts';
import {
  createGeminiWebClient,
  type WebRequestOptions,
  type WebResponseInfo,
} from '../extensions/gemini-web/client.ts';
import {
  GeminiWebError,
  safeWebError,
  type WebModel,
} from '../extensions/gemini-web/protocol.ts';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gemini-web-client-test-'));
}

function makeSyntheticBootstrapHtml(at = 'tok_bootstrap_123', bl = 'bl_999', sid = 'sid_888'): string {
  return `<html><head><script>window.WIZ_global_data = {"SNlM0e":"${at}","cfb2h":"${bl}","FdrFJe":"${sid}","TuX5cc":"en"};</script></head><body></body></html>`;
}

function makeSyntheticDiscoveryPayload(models: Array<{ id: string; name: string; capacity: number; capacityField: 12 | 13; modelNumber: number }>): string {
  const entries = models.map((m) => [
    m.id,
    'Synthetic Label',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    m.modelNumber,
    null,
    m.name,
    null,
    null,
    null,
    null,
    null,
    m.modelNumber,
  ]);
  const status = new Array(18).fill(null);
  status[14] = 1000;
  status[15] = entries;
  // Tier 21 -> capacity 1, capacityField 13; capability 115 -> capacity 4, capacityField 12
  status[16] = [21];
  status[17] = [];
  const inner = JSON.stringify([['wrb.fr', 'otAQ7b', JSON.stringify(status), null, null, null, 'generic']]);
  return `)]}'\n${Buffer.byteLength(inner, 'utf8')}\n${inner}\n`;
}

function makeSyntheticGenerationPayload(text: string): string {
  const inner = JSON.stringify([[
    'wrb.fr',
    null,
    JSON.stringify([null, null, null, null, [['rc_test', [text]]]]),
  ]]);
  return `)]}'\n${Buffer.byteLength(inner, 'utf8')}\n${inner}\n`;
}

test('parseCookieImport: parses valid header and preserves rollout cookies', () => {
  const header =
    '__Secure-1PSID=psid_val; __Secure-1PSIDTS=psidts_val; NID=511=nid_val; __Secure-3PSID=psid3_val';
  const cred = parseCookieImport(header, 0, 1000000, 'rev-1');
  assert.equal(cred.version, 1);
  assert.equal(cred.revision, 'rev-1');
  assert.equal(cred.authUser, 0);
  assert.equal(cred.updatedAt, 1000000);
  assert.deepEqual(cred.models, []);
  assert.match(cred.cookieHeader, /__Secure-1PSID=psid_val/);
  assert.match(cred.cookieHeader, /__Secure-1PSIDTS=psidts_val/);
  assert.match(cred.cookieHeader, /NID=511=nid_val/);

  // Optional leading Cookie: prefix is stripped
  const withPrefix = `Cookie: ${header}`;
  const cred2 = parseCookieImport(withPrefix, 1, 2000000, 'rev-2');
  assert.equal(cred2.authUser, 1);
  assert.equal(cred2.cookieHeader, cred.cookieHeader);
});

test('parseCookieImport: rejects missing auth cookies, empty values, duplicates, and invalid authUser', () => {
  // Missing __Secure-1PSIDTS
  assert.throws(
    () => parseCookieImport('__Secure-1PSID=abc; other=123', 0, 1000, 'rev'),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'credentials',
  );

  // Missing __Secure-1PSID
  assert.throws(
    () => parseCookieImport('__Secure-1PSIDTS=abc; other=123', 0, 1000, 'rev'),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'credentials',
  );

  // Empty value for required cookie
  assert.throws(
    () => parseCookieImport('__Secure-1PSID=; __Secure-1PSIDTS=abc', 0, 1000, 'rev'),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'credentials',
  );

  // Duplicate cookie names
  assert.throws(
    () => parseCookieImport('__Secure-1PSID=a; __Secure-1PSID=b; __Secure-1PSIDTS=c', 0, 1000, 'rev'),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'credentials',
  );

  // Cookie attribute masquerading as cookie name
  assert.throws(
    () => parseCookieImport('__Secure-1PSID=a; __Secure-1PSIDTS=b; Domain=google.com', 0, 1000, 'rev'),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'credentials',
  );

  // Control characters or CRLF
  assert.throws(
    () => parseCookieImport('__Secure-1PSID=a\r\n; __Secure-1PSIDTS=b', 0, 1000, 'rev'),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'credentials',
  );

  // Invalid authUser
  assert.throws(
    () => parseCookieImport('__Secure-1PSID=a; __Secure-1PSIDTS=b', -1, 1000, 'rev'),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'credentials',
  );
  assert.throws(
    () => parseCookieImport('__Secure-1PSID=a; __Secure-1PSIDTS=b', 1.5, 1000, 'rev'),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'credentials',
  );

  // Header exceeding 64KiB
  const hugeHeader = `__Secure-1PSID=a; __Secure-1PSIDTS=b; extra=${'x'.repeat(65536)}`;
  assert.throws(
    () => parseCookieImport(hugeHeader, 0, 1000, 'rev'),
    (err: unknown) => err instanceof GeminiWebError && err.code === 'credentials',
  );
});

test('readCookieImport: validates 0600 file permissions and owner, rejects symlinks and oversized files', async () => {
  const dir = createTempDir();
  try {
    const validFile = join(dir, 'cookies.txt');
    writeFileSync(validFile, '__Secure-1PSID=psid; __Secure-1PSIDTS=psidts', { mode: 0o600 });

    const cred = await readCookieImport(validFile, 0);
    assert.equal(cred.authUser, 0);
    assert.match(cred.cookieHeader, /__Secure-1PSID=psid/);

    // Rejects insecure permissions (0o644)
    chmodSync(validFile, 0o644);
    await assert.rejects(
      readCookieImport(validFile, 0),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'credentials',
    );

    // Rejects symlink
    chmodSync(validFile, 0o600);
    const linkFile = join(dir, 'link.txt');
    symlinkSync(validFile, linkFile);
    await assert.rejects(
      readCookieImport(linkFile, 0),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'credentials',
    );

    // Rejects missing file
    await assert.rejects(
      readCookieImport(join(dir, 'missing.txt'), 0),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'credentials',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CookieCredentialStore: read, save, fail closed on corrupt JSON, and atomic update with locking', async () => {
  const dir = createTempDir();
  try {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    // Missing file returns undefined
    const initial = await store.read();
    assert.equal(initial, undefined);

    const testCred: CookieCredential = {
      version: 1,
      revision: 'rev-store-1',
      cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=b',
      authUser: 1,
      updatedAt: 1234567,
      models: [
        {
          id: 'model-flash',
          name: 'Gemini 2.0 Flash',
          capacity: 1,
          capacityField: 13,
          modelNumber: 1,
        },
      ],
    };

    // Save and read back
    await store.save(testCred);
    const loaded = await store.read();
    assert.deepEqual(loaded, testCred);

    // Corrupt JSON fails closed with storage error
    writeFileSync(storePath, '{ corrupt json', { mode: 0o600 });
    await assert.rejects(
      store.read(),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'storage',
    );

    // Update with concurrent locking
    await store.save(testCred);
    const updated = await store.update((current) => {
      assert.ok(current);
      return {
        ...current,
        updatedAt: 9999999,
      };
    });
    assert.equal(updated?.updatedAt, 9999999);

    // Update returning undefined deletes file
    await store.update(() => undefined);
    const deleted = await store.read();
    assert.equal(deleted, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GeminiWebClient.refresh: performs model discovery with correct slot routing and headers', async () => {
  const dir = createTempDir();
  try {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const cred: CookieCredential = {
      version: 1,
      revision: 'rev-client-1',
      cookieHeader: '__Secure-1PSID=psid_0; __Secure-1PSIDTS=psidts_0',
      authUser: 2, // Slot 2
      updatedAt: 1000000,
      models: [],
    };
    await store.save(cred);

    const requestsMade: Array<{ url: string; method?: string; headers: Record<string, string> }> = [];

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      const headersRecord: Record<string, string> = {};
      if (init?.headers) {
        new Headers(init.headers as any).forEach((val, key) => {
          headersRecord[key] = val;
        });
      }
      requestsMade.push({ url, method: init?.method, headers: headersRecord });

      if (url.includes('/u/2/app?hl=en')) {
        return new Response(makeSyntheticBootstrapHtml('token_at_2', 'bl_2', 'sid_2'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }

      if (url.includes('/u/2/_/BardChatUi/data/batchexecute')) {
        const modelsPayload = makeSyntheticDiscoveryPayload([
          {
            id: 'models/gemini-2.0-flash',
            name: 'Gemini 2.0 Flash',
            capacity: 1,
            capacityField: 13,
            modelNumber: 1,
          },
        ]);
        return new Response(modelsPayload, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = createGeminiWebClient(store, {
      fetch: mockFetch,
      now: () => 1000000, // Recent, no rotation needed
      randomUUID: () => 'uuid-fixed-1',
    });

    const models = await client.refresh();
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'models/gemini-2.0-flash');
    assert.equal(models[0].name, 'Gemini 2.0 Flash');

    // Verify slot routing
    assert.equal(requestsMade.length, 2);
    assert.match(requestsMade[0].url, /https:\/\/gemini\.google\.com\/u\/2\/app\?hl=en/);
    assert.match(requestsMade[1].url, /https:\/\/gemini\.google\.com\/u\/2\/_\/BardChatUi\/data\/batchexecute/);
    assert.match(requestsMade[1].url, /source-path=%2Fu%2F2%2Fapp/);

    // Verify credentials persisted with models
    const stored = await store.read();
    assert.equal(stored?.models.length, 1);
    assert.equal(stored?.catalogCheckedAt, 1000000);

    client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GeminiWebClient.refresh: opportunistic cookie rotation when >= 24h old, narrow headers, and survival on bootstrap failure', async () => {
  const dir = createTempDir();
  try {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const now = 200_000_000;
    const cred: CookieCredential = {
      version: 1,
      revision: 'rev-rot-1',
      cookieHeader: '__Secure-1PSID=psid_old; __Secure-1PSIDTS=psidts_old; extra=rollout_val',
      authUser: 0,
      updatedAt: now - 25 * 60 * 60 * 1000, // 25 hours old (> 24h)
      models: [
        {
          id: 'model-pro',
          name: 'Gemini 1.5 Pro',
          capacity: 1,
          capacityField: 13,
          modelNumber: 2,
        },
      ],
    };
    await store.save(cred);

    const requestsMade: Array<{ url: string; headers: Record<string, string> }> = [];

    // Mock where rotation succeeds with new PSIDTS, but bootstrap subsequently fails
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      const headersRecord: Record<string, string> = {};
      if (init?.headers) {
        new Headers(init.headers as any).forEach((val, key) => {
          headersRecord[key] = val;
        });
      }
      requestsMade.push({ url, headers: headersRecord });

      if (url === 'https://accounts.google.com/RotateCookies') {
        const headers = new Headers();
        headers.append(
          'set-cookie',
          '__Secure-1PSIDTS=psidts_ROTATED_NEW; Domain=.google.com; Path=/; Secure; HttpOnly',
        );
        return new Response('[]', { status: 200, headers });
      }

      if (url.includes('/u/0/app?hl=en')) {
        // Bootstrap fails with 401
        return new Response('Unauthorized', { status: 401 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = createGeminiWebClient(store, {
      fetch: mockFetch,
      now: () => now,
    });

    // Refresh throws auth error because bootstrap failed
    await assert.rejects(
      client.refresh(),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'auth',
    );

    // Verify narrow auth cookie was sent to accounts.google.com (never rollout cookies)
    assert.equal(requestsMade[0].url, 'https://accounts.google.com/RotateCookies');
    assert.match(requestsMade[0].headers.cookie, /__Secure-1PSID=psid_old/);
    assert.match(requestsMade[0].headers.cookie, /__Secure-1PSIDTS=psidts_old/);
    assert.doesNotMatch(requestsMade[0].headers.cookie, /extra=rollout_val/);

    // Verify rotated cookie survived and was persisted to disk!
    const reloaded = await store.read();
    assert.ok(reloaded);
    assert.match(reloaded.cookieHeader, /__Secure-1PSIDTS=psidts_ROTATED_NEW/);
    assert.match(reloaded.cookieHeader, /extra=rollout_val/); // Preserved extra cookie
    assert.equal(reloaded.lastRotationAt, now);
    assert.equal(reloaded.models.length, 1); // Previous model preserved

    client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GeminiWebClient: rejects redirects on rotation, bootstrap, discovery, and generation', async () => {
  const dir = createTempDir();
  try {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const cred: CookieCredential = {
      version: 1,
      revision: 'rev-red-1',
      cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=b',
      authUser: 0,
      updatedAt: Date.now(),
      models: [
        {
          id: 'model-flash',
          name: 'Gemini 2.0 Flash',
          capacity: 1,
          capacityField: 13,
          modelNumber: 1,
        },
      ],
    };
    await store.save(cred);

    // Mock returning 302 redirect
    const mockRedirectFetch: typeof globalThis.fetch = async () => {
      return new Response('', {
        status: 302,
        headers: { location: 'https://accounts.google.com/signin' },
      });
    };

    const client = createGeminiWebClient(store, { fetch: mockRedirectFetch });

    // Refresh should reject redirect with auth error
    await assert.rejects(
      client.refresh(),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'auth',
    );

    // Generate should reject redirect with auth error
    await assert.rejects(
      client.generate('model-flash', { prompt: 'Hello' }),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'auth',
    );

    client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GeminiWebClient.generate: executes generation with exact routing headers, onPayload prompt replacement, onResponse safe headers, and onFrame', async () => {
  const dir = createTempDir();
  try {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const model: WebModel = {
      id: 'models/gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      capacity: 2,
      capacityField: 12,
      modelNumber: 1,
    };

    const cred: CookieCredential = {
      version: 1,
      revision: 'rev-gen-1',
      cookieHeader: '__Secure-1PSID=psid_v; __Secure-1PSIDTS=psidts_v',
      authUser: 0,
      updatedAt: 1000000,
      models: [model],
    };
    await store.save(cred);

    let capturedPostUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/u/0/app?hl=en')) {
        return new Response(makeSyntheticBootstrapHtml('token_gen_at', 'bl_gen', 'sid_gen'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }

      if (url.includes('/StreamGenerate')) {
        capturedPostUrl = url;
        capturedBody = String(init?.body);
        new Headers(init?.headers as any).forEach((val, key) => {
          capturedHeaders[key] = val;
        });

        const genPayload = makeSyntheticGenerationPayload('Hello generated response!');
        return new Response(genPayload, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'retry-after': '60',
            'set-cookie': 'secret_cookie=leak; Path=/', // Must not leak to onResponse
            'location': 'https://secret.com', // Must not leak to onResponse
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = createGeminiWebClient(store, {
      fetch: mockFetch,
      now: () => 1000000,
      randomUUID: () => 'uuid-gen-1',
    });

    let exposedResponse: WebResponseInfo | undefined;
    const receivedFrames: unknown[] = [];

    const options: WebRequestOptions = {
      onPayload: (payload) => {
        assert.equal(payload.prompt, 'Original prompt');
        return { prompt: 'Replaced prompt by hook' };
      },
      onResponse: (response) => {
        exposedResponse = response;
      },
      onFrame: (frame) => {
        receivedFrames.push(frame);
      },
    };

    const generation = await client.generate(model.id, { prompt: 'Original prompt' }, options);
    assert.equal(generation.text, 'Hello generated response!');

    // Verify wire URL and model header
    assert.match(capturedPostUrl, /https:\/\/gemini\.google\.com\/u\/0\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate/);
    assert.match(capturedHeaders['cookie'], /__Secure-1PSID=psid_v/);

    // Verify 81-slot body received replaced prompt
    const parsedBody = new URLSearchParams(capturedBody);
    assert.equal(parsedBody.get('at'), 'token_gen_at');
    const innerReq = JSON.parse(parsedBody.get('f.req') ?? '[]');
    const innerData = JSON.parse(innerReq[1]);
    assert.equal(innerData.length, 81);
    assert.deepEqual(innerData[0], ['Replaced prompt by hook']);

    // Verify onResponse safe headers (no Set-Cookie, no Location)
    assert.ok(exposedResponse);
    assert.equal(exposedResponse.status, 200);
    assert.equal(exposedResponse.headers['content-type'], 'application/json');
    assert.equal(exposedResponse.headers['retry-after'], '60');
    assert.equal(exposedResponse.headers['set-cookie'], undefined);
    assert.equal(exposedResponse.headers['location'], undefined);

    // Verify onFrame received frames
    assert.ok(receivedFrames.length > 0);

    // Test bootstrap TTL caching: second call does not re-fetch bootstrap HTML
    let bootstrapFetchCount = 0;
    const mockFetch2: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/u/0/app?hl=en')) {
        bootstrapFetchCount++;
        return new Response(makeSyntheticBootstrapHtml('token_gen_at', 'bl_gen', 'sid_gen'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(makeSyntheticGenerationPayload('Second answer'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client2 = createGeminiWebClient(store, {
      fetch: mockFetch2,
      now: () => 1000000,
    });
    await client2.generate(model.id, { prompt: 'Call 1' });
    assert.equal(bootstrapFetchCount, 1);
    await client2.generate(model.id, { prompt: 'Call 2' });
    assert.equal(bootstrapFetchCount, 1); // Still 1! Reused cached bootstrap within 10min TTL.

    // Rejects unknown model
    await assert.rejects(
      client2.generate('unknown-model-id', { prompt: 'Test' }),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'model',
    );

    client.close();
    client2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GeminiWebClient: no duplicate generation retries on network/HTTP failure and bootstrap invalidation on 401', async () => {
  const dir = createTempDir();
  try {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const model: WebModel = {
      id: 'models/gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };
    const cred: CookieCredential = {
      version: 1,
      revision: 'rev-retry-1',
      cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=b',
      authUser: 0,
      updatedAt: 1000000,
      models: [model],
    };
    await store.save(cred);

    let generateAttempts = 0;
    const mockFailFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/u/0/app?hl=en')) {
        return new Response(makeSyntheticBootstrapHtml(), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.includes('/StreamGenerate')) {
        generateAttempts++;
        return new Response('Rate limited', { status: 429 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = createGeminiWebClient(store, {
      fetch: mockFailFetch,
      now: () => 1000000,
    });

    // Request should fail immediately without retrying generation POST
    await assert.rejects(
      client.generate(model.id, { prompt: 'Test rate limit' }),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'http' && err.status === 429,
    );
    assert.equal(generateAttempts, 1); // Exactly 1 attempt! No duplicate generation replay.

    // 401 on generation invalidates bootstrap
    let authFailAttempts = 0;
    let bootstrapAttempts = 0;
    const mockAuthFailFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/u/0/app?hl=en')) {
        bootstrapAttempts++;
        return new Response(makeSyntheticBootstrapHtml(), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.includes('/StreamGenerate')) {
        authFailAttempts++;
        return new Response('Unauthorized', { status: 401 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const clientAuth = createGeminiWebClient(store, {
      fetch: mockAuthFailFetch,
      now: () => 1000000,
    });

    await assert.rejects(
      clientAuth.generate(model.id, { prompt: 'Test auth' }),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'auth',
    );
    assert.equal(authFailAttempts, 1);
    assert.equal(bootstrapAttempts, 1);

    // Second call must re-fetch bootstrap because 401 invalidated it
    await assert.rejects(
      clientAuth.generate(model.id, { prompt: 'Test auth 2' }),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'auth',
    );
    assert.equal(bootstrapAttempts, 2); // Re-fetched bootstrap!

    client.close();
    clientAuth.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GeminiWebClient: bounded body enforcement cancels oversized streams', async () => {
  const dir = createTempDir();
  try {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const model: WebModel = {
      id: 'models/gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };
    await store.save({
      version: 1,
      revision: 'rev-bound-1',
      cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=b',
      authUser: 0,
      updatedAt: 1000000,
      models: [model],
    });

    let readerCancelled = false;
    const hugeChunk = new Uint8Array(1024 * 1024); // 1 MiB chunk

    const mockOversizedFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/u/0/app?hl=en')) {
        return new Response(makeSyntheticBootstrapHtml(), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }

      // Stream that exceeds 16 MiB
      let chunksSent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksSent < 20) {
            chunksSent++;
            controller.enqueue(hugeChunk);
          } else {
            controller.close();
          }
        },
        cancel() {
          readerCancelled = true;
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = createGeminiWebClient(store, {
      fetch: mockOversizedFetch,
      now: () => 1000000,
    });

    await assert.rejects(
      client.generate(model.id, { prompt: 'Large body test' }),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'protocol',
    );
    assert.equal(readerCancelled, true);

    client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GeminiWebClient: abort signal and close() abort in-flight requests and prevent new operations', async () => {
  const dir = createTempDir();
  try {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const model: WebModel = {
      id: 'models/gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };
    await store.save({
      version: 1,
      revision: 'rev-abort-1',
      cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=b',
      authUser: 0,
      updatedAt: 1000000,
      models: [model],
    });

    // 1. Caller abort signal before call
    const preAborted = AbortSignal.abort(new Error('Caller cancelled'));
    const client = createGeminiWebClient(store);
    await assert.rejects(
      client.generate(model.id, { prompt: 'Hello' }, { signal: preAborted }),
      (err: unknown) => err instanceof Error && err.message === 'Caller cancelled',
    );

    // 2. Client close() aborts and rejects further calls with 'closed'
    client.close();
    await assert.rejects(
      client.refresh(),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'closed',
    );
    await assert.rejects(
      client.generate(model.id, { prompt: 'Hello' }),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'closed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
