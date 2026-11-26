// Adapted from gemini-web-to-api (https://github.com/ntthanh2603/gemini-web-to-api)
// Pinned upstream commit: 1f1577dbd479d5b61a1c5f03de742ffcdeb51f6d
// Copyright (c) 2025 Nguyễn Tuấn Thành
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import {
  CookieCredentialStore,
  parseCookieImport,
  readCookieImport,
  type CookieCredential,
} from '../extensions/gemini-web/auth.ts';
import {
  createDefaultFetchTransport,
  createGeminiWebClient,
  type GeminiWebClient,
  type WebRequestOptions,
  type WebResponseInfo,
} from '../extensions/gemini-web/client.ts';
import {
  GeminiWebError,
  safeWebError,
  type WebModel,
} from '../extensions/gemini-web/protocol.ts';
import {
  createTestCredential,
  makeSyntheticBootstrapHtml,
  makeSyntheticDiscoveryPayload,
  makeSyntheticGenerationPayload,
  withTempDir,
} from './helpers/gemini-web.ts';

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
  await withTempDir(async (dir) => {
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
  });
});

test('CookieCredentialStore: read, save, fail closed on corrupt JSON, and atomic update with locking', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    // Missing file returns undefined
    const initial = await store.read();
    assert.equal(initial, undefined);

    const testCred = createTestCredential({
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
    });

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
  });
});

test('GeminiWebClient.refresh: performs model discovery with correct slot routing and headers', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const cred = createTestCredential({
      revision: 'rev-client-1',
      cookieHeader: '__Secure-1PSID=psid_0; __Secure-1PSIDTS=psidts_0',
      authUser: 2, // Slot 2
      models: [],
    });
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
  });
});

test('GeminiWebClient.refresh: opportunistic cookie rotation when >= 24h old, narrow headers, and survival on bootstrap failure', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const now = 200_000_000;
    const cred = createTestCredential({
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
    });
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
  });
});

test('GeminiWebClient: rejects redirects on rotation, bootstrap, discovery, and generation', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const cred = createTestCredential({
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
    });
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
  });
});

test('GeminiWebClient.generate: executes generation with exact routing headers, onPayload prompt replacement, onResponse safe headers, and onFrame', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const model: WebModel = {
      id: 'models/gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      capacity: 2,
      capacityField: 12,
      modelNumber: 1,
    };

    const cred = createTestCredential({
      revision: 'rev-gen-1',
      cookieHeader: '__Secure-1PSID=psid_v; __Secure-1PSIDTS=psidts_v',
      models: [model],
    });
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
  });
});

test('GeminiWebClient: no duplicate generation retries on network/HTTP failure and bootstrap invalidation on 401', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const model: WebModel = {
      id: 'models/gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };
    const cred = createTestCredential({
      revision: 'rev-retry-1',
      cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=b',
      models: [model],
    });
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
  });
});

test('GeminiWebClient: bounded body enforcement cancels oversized streams', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const model: WebModel = {
      id: 'models/gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };
    await store.save(createTestCredential({
      revision: 'rev-bound-1',
      cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=b',
      models: [model],
    }));

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
  });
});

test('GeminiWebClient: abort signal and close() abort in-flight requests and prevent new operations', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const model: WebModel = {
      id: 'models/gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };
    await store.save(createTestCredential({
      revision: 'rev-abort-1',
      cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=b',
      models: [model],
    }));

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
  });
});

test('GeminiWebClient: AsyncMutex.acquire abort bug regression - waiter 2 rejects promptly while waiter 1 blocked, waiter 3 proceeds', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const model: WebModel = {
      id: 'models/gemini-mutex-test',
      name: 'Gemini Mutex Test',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };
    await store.save(createTestCredential({
      revision: 'rev-mutex-1',
      cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=b',
      models: [model],
    }));

    let resolveFirstBootstrap: (res: Response) => void;
    const firstBootstrapPromise = new Promise<Response>((resolve) => {
      resolveFirstBootstrap = resolve;
    });

    let bootstrapCalls = 0;
    const fakeFetch = (async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('gemini.google.com/u/0/app')) {
        bootstrapCalls++;
        if (bootstrapCalls === 1) {
          return firstBootstrapPromise;
        }
        return new Response(makeSyntheticBootstrapHtml(), { status: 200 });
      }
      if (u.includes('StreamGenerate')) {
        return new Response(makeSyntheticGenerationPayload('success'), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    }) as any;

    const client = createGeminiWebClient(store, { fetch: fakeFetch });

    // Waiter 1: acquires lock, blocked waiting for firstBootstrapPromise
    const call1 = client.generate(model.id, { prompt: 'call1' });

    // Wait a tick so waiter 1 acquires lock and calls fetch
    await new Promise((r) => setTimeout(r, 20));

    // Waiter 2: queued in AsyncMutex, will be aborted
    const abort2 = new AbortController();
    const call2 = client.generate(model.id, { prompt: 'call2' }, { signal: abort2.signal });

    // Waiter 3: queued in AsyncMutex, healthy
    const call3 = client.generate(model.id, { prompt: 'call3' });

    // Abort waiter 2
    abort2.abort(new Error('Abort waiter 2'));

    // Assert waiter 2 rejects promptly while waiter 1 is STILL blocked!
    await assert.rejects(call2, (err: unknown) => err instanceof Error && err.message === 'Abort waiter 2');

    // Waiter 1 is still pending
    resolveFirstBootstrap!(new Response(makeSyntheticBootstrapHtml(), { status: 200 }));
    const res1 = await call1;
    assert.equal(res1.text, 'success');

    // Waiter 3 proceeds and resolves
    const res3 = await call3;
    assert.equal(res3.text, 'success');
  });
});

test('GeminiWebClient: HTTP cancellation and timeout lifetime with hanging body', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const model: WebModel = {
      id: 'models/gemini-hang-test',
      name: 'Gemini Hang Test',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };
    await store.save(createTestCredential({
      revision: 'rev-hang-1',
      cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=b',
      models: [model],
    }));

    function createHangingStream(): ReadableStream<Uint8Array> {
      return new ReadableStream({
        start() {
          // Never emits chunks or closes
        },
      });
    }

    // 1. Caller abort on hanging body
    {
      const abortCtrl = new AbortController();
      let streamGenerateAttempts = 0;

      const fakeFetch = (async (url: string | URL) => {
        const u = url.toString();
        if (u.includes('gemini.google.com/u/0/app')) {
          return new Response(makeSyntheticBootstrapHtml(), { status: 200 });
        }
        if (u.includes('StreamGenerate')) {
          streamGenerateAttempts++;
          // Trigger caller abort shortly after headers return
          setTimeout(() => abortCtrl.abort(new Error('Caller cancelled during body')), 20);
          return new Response(createHangingStream(), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch: ${u}`);
      }) as any;

      const client = createGeminiWebClient(store, { fetch: fakeFetch });
      await assert.rejects(
        client.generate(model.id, { prompt: 'test' }, { signal: abortCtrl.signal }),
        (err: unknown) => err instanceof Error && err.message === 'Caller cancelled during body',
      );
      // No generation replay!
      assert.equal(streamGenerateAttempts, 1);
    }

    // 2. Timeout on hanging body
    {
      let streamGenerateAttempts = 0;
      const fakeFetch = (async (url: string | URL) => {
        const u = url.toString();
        if (u.includes('gemini.google.com/u/0/app')) {
          return new Response(makeSyntheticBootstrapHtml(), { status: 200 });
        }
        if (u.includes('StreamGenerate')) {
          streamGenerateAttempts++;
          return new Response(createHangingStream(), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch: ${u}`);
      }) as any;

      const client = createGeminiWebClient(store, { fetch: fakeFetch });
      await assert.rejects(
        client.generate(model.id, { prompt: 'test' }, { timeoutMs: 50 }),
        (err: unknown) => err instanceof GeminiWebError && err.code === 'network',
      );
      assert.equal(streamGenerateAttempts, 1);
    }

    // 3. Client close() on hanging body
    {
      let clientRef: GeminiWebClient;
      let streamGenerateAttempts = 0;
      const fakeFetch = (async (url: string | URL) => {
        const u = url.toString();
        if (u.includes('gemini.google.com/u/0/app')) {
          return new Response(makeSyntheticBootstrapHtml(), { status: 200 });
        }
        if (u.includes('StreamGenerate')) {
          streamGenerateAttempts++;
          setTimeout(() => clientRef.close(), 20);
          return new Response(createHangingStream(), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch: ${u}`);
      }) as any;

      const client = createGeminiWebClient(store, { fetch: fakeFetch });
      clientRef = client;
      await assert.rejects(
        client.generate(model.id, { prompt: 'test' }),
        (err: unknown) => err instanceof GeminiWebError && err.code === 'closed',
      );
      assert.equal(streamGenerateAttempts, 1);
    }
  });
});

test('GeminiWebClient: fresh bootstrap cookies persisted, used in generation, and restart retains it', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const model: WebModel = {
      id: 'models/gemini-cookie-test',
      name: 'Gemini Cookie Test',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };
    await store.save(createTestCredential({
      revision: 'rev-cookie-1',
      cookieHeader: '__Secure-1PSID=initial_psid; __Secure-1PSIDTS=initial_ts',
      models: [model],
    }));

    let generateSentCookie = '';
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('gemini.google.com/u/0/app')) {
        const resHeaders = new Headers();
        // Google bootstrap sets refreshed __Secure-1PSIDTS
        resHeaders.append(
          'set-cookie',
          '__Secure-1PSIDTS=refreshed_ts_123; Domain=.google.com; Path=/; Secure; HttpOnly',
        );
        return new Response(makeSyntheticBootstrapHtml(), {
          status: 200,
          headers: resHeaders,
        });
      }
      if (u.includes('StreamGenerate')) {
        generateSentCookie = (init?.headers as Record<string, string>)?.Cookie ?? '';
        return new Response(makeSyntheticGenerationPayload('cookie response'), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    }) as any;

    const client = createGeminiWebClient(store, { fetch: fakeFetch });
    const gen = await client.generate(model.id, { prompt: 'test cookies' });
    assert.equal(gen.text, 'cookie response');

    // 1. Generation request used the refreshed cookie!
    assert.match(generateSentCookie, /__Secure-1PSIDTS=refreshed_ts_123/);

    // 2. Stored credential retains the refreshed cookie
    const updatedCred = await store.read();
    assert.ok(updatedCred);
    assert.match(updatedCred.cookieHeader, /__Secure-1PSIDTS=refreshed_ts_123/);

    // 3. Restarted client from store uses the refreshed cookie
    const restartedClient = createGeminiWebClient(store, { fetch: fakeFetch });
    await restartedClient.generate(model.id, { prompt: 'test restart' });
    assert.match(generateSentCookie, /__Secure-1PSIDTS=refreshed_ts_123/);
  });
});

test('GeminiWebClient: adversarial Set-Cookie domain, path, Max-Age precedence, and auth deletion fail-closed', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const model: WebModel = {
      id: 'models/gemini-cookie-adv',
      name: 'Gemini Cookie Adv',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };

    // 1. Host-only accounts cookie and path-restricted rotation cookies are rejected
    {
      await store.save(createTestCredential({
        revision: 'rev-adv-1',
        cookieHeader: '__Secure-1PSID=psid_v; __Secure-1PSIDTS=psidts_v',
        updatedAt: 1000,
        models: [model],
      }));

      const fakeFetch = (async (url: string | URL) => {
        const u = url.toString();
        if (u.includes('accounts.google.com/RotateCookies')) {
          const headers = new Headers();
          // Host-only cookie to accounts.google.com (no Domain=.google.com): MUST NOT be merged
          headers.append('set-cookie', '__Host-GAPS=secret_gaps; Path=/; Secure');
          // Path-restricted cookie: MUST NOT be merged
          headers.append(
            'set-cookie',
            '__Secure-1PSIDTS=new_ts; Domain=.google.com; Path=/RotateCookies; Secure',
          );
          // Valid rotated cookie
          headers.append(
            'set-cookie',
            '__Secure-3PSIDTS=valid_3ts; Domain=.google.com; Path=/; Secure',
          );
          return new Response('[000,"0"]', { status: 200, headers });
        }
        if (u.includes('gemini.google.com/u/0/app')) {
          return new Response(makeSyntheticBootstrapHtml(), { status: 200 });
        }
        if (u.includes('batchexecute')) {
          return new Response(makeSyntheticDiscoveryPayload([model]), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${u}`);
      }) as any;

      const client = createGeminiWebClient(store, {
        fetch: fakeFetch,
        now: () => 1000 + 25 * 3600 * 1000, // 25 hours later, triggers rotation
      });

      await client.refresh();

      const cred = await store.read();
      assert.ok(cred);
      assert.doesNotMatch(cred.cookieHeader, /__Host-GAPS/);
      assert.doesNotMatch(cred.cookieHeader, /new_ts/); // Path=/RotateCookies rejected
      assert.match(cred.cookieHeader, /__Secure-3PSIDTS=valid_3ts/);
    }

    // 2. Auth deletion fail-closed: if rotation or bootstrap deletes __Secure-1PSIDTS, fail closed with auth error
    {
      const fakeFetchDelete = (async (url: string | URL) => {
        const u = url.toString();
        if (u.includes('gemini.google.com/u/0/app')) {
          const headers = new Headers();
          // Adversarial server deletes __Secure-1PSIDTS via Max-Age=0
          headers.append(
            'set-cookie',
            '__Secure-1PSIDTS=; Max-Age=0; Domain=.google.com; Path=/; Secure',
          );
          return new Response(makeSyntheticBootstrapHtml(), { status: 200, headers });
        }
        throw new Error(`Unexpected fetch: ${u}`);
      }) as any;

      const client = createGeminiWebClient(store, { fetch: fakeFetchDelete });
      await assert.rejects(
        client.generate(model.id, { prompt: 'test' }),
        (err: unknown) => err instanceof GeminiWebError && err.code === 'auth',
      );
    }
  });
});

test('default transport: supports oversized (>16KiB, <64KiB) response headers, dispatcher cleanup, and injected-fetch precedence', async () => {
  // 1. Local HTTP fixture returning 25KiB header
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'x-oversized-header': 'x'.repeat(25 * 1024),
    });
    res.end('oversized-headers-ok');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const targetUrl = `http://127.0.0.1:${port}`;

  const transport = createDefaultFetchTransport();
  try {
    // Standard globalThis.fetch fails with UND_ERR_HEADERS_OVERFLOW
    let globalFailed = false;
    try {
      await globalThis.fetch(targetUrl);
    } catch (err: any) {
      globalFailed = true;
      assert.equal(err.cause?.code, 'UND_ERR_HEADERS_OVERFLOW');
    }
    assert.equal(globalFailed, true);

    // Default transport with 64KiB header support succeeds
    const res = await transport.fetch(targetUrl);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, 'oversized-headers-ok');
  } finally {
    await transport.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // 2. Injected-fetch precedence: dependencies.fetch and options.fetch are preserved without private wrapping
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    const model: WebModel = {
      id: 'models/gemini-transport-test',
      name: 'Gemini Transport Test',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };
    await store.save(createTestCredential({
      revision: 'rev-tp-1',
      cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=b',
      updatedAt: 1000,
      models: [model],
    }));

    let depFetchCalls = 0;
    const depFetch = (async () => {
      depFetchCalls++;
      return new Response(makeSyntheticBootstrapHtml(), { status: 200 });
    }) as any;

    let optFetchCalls = 0;
    const optFetch = (async () => {
      optFetchCalls++;
      return new Response(makeSyntheticBootstrapHtml(), { status: 200 });
    }) as any;

    const client = createGeminiWebClient(store, { fetch: depFetch });
    const fakeBootstrapOpt = (client as any).doBootstrap(
      createTestCredential({
        revision: 'rev-tp-1',
        cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=b',
        updatedAt: 1000,
        models: [model],
      }),
      { fetch: optFetch },
    );

    await fakeBootstrapOpt;
    assert.equal(optFetchCalls, 1);
    assert.equal(depFetchCalls, 0);

    // Client close() cleans up default transport idempotently without throwing
    client.close();
    client.close();
  });
});

test('GeminiWebClient.generate: friendly ID resolution sends raw routing ID in wire headers, supports legacy raw ID, and rejects unknown ID', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    // Using one of the user-observed models
    const rawRoutingId = '8c46e95b1a07cecc';
    const model: WebModel = {
      id: rawRoutingId,
      name: '3.5 Flash-Lite',
      capacity: 1,
      capacityField: 13,
      modelNumber: 2,
    };

    // Two colliding models sharing the same first 8 hex characters and display name
    const rawCollidingA = '1111222233334444';
    const rawCollidingB = '11112222aaaaaaaa';
    const modelColA: WebModel = {
      id: rawCollidingA,
      name: '3.8 Flash',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };
    const modelColB: WebModel = {
      id: rawCollidingB,
      name: '3.8 Flash',
      capacity: 1,
      capacityField: 13,
      modelNumber: 1,
    };

    const cred = createTestCredential({
      revision: 'rev-naming-1',
      cookieHeader: '__Secure-1PSID=psid_val; __Secure-1PSIDTS=psidts_val',
      models: [model, modelColA, modelColB],
    });
    await store.save(cred);

    let capturedHeaders: Record<string, string> = {};

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/u/0/app?hl=en')) {
        return new Response(makeSyntheticBootstrapHtml('token_naming', 'bl_naming', 'sid_naming'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.includes('/StreamGenerate')) {
        new Headers(init?.headers as any).forEach((val, key) => {
          capturedHeaders[key] = val;
        });
        return new Response(makeSyntheticGenerationPayload('Answer from 3.5 Flash-Lite'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = createGeminiWebClient(store, {
      fetch: mockFetch,
      now: () => 1000000,
    });

    // 1. Generation by friendly ID 'gemini-3.5-flash-lite'
    const genFriendly = await client.generate('gemini-3.5-flash-lite', { prompt: 'Hi friendly' });
    assert.equal(genFriendly.text, 'Answer from 3.5 Flash-Lite');

    // Verify wire header contains raw routing ID '8c46e95b1a07cecc' in slot 4
    const modelHeaderFriendly = capturedHeaders['x-goog-ext-525001261-jspb'];
    assert.ok(modelHeaderFriendly, 'x-goog-ext-525001261-jspb header must be present');
    const parsedHeaderFriendly = JSON.parse(modelHeaderFriendly);
    // Slot 4 is the routing model ID
    assert.equal(parsedHeaderFriendly[4], rawRoutingId);
    // Offset for capacityField=13 is 13 - 12 = 1; model number at 14+offset = 15
    assert.equal(parsedHeaderFriendly[15], 2);

    // 2. Generation by raw ID '8c46e95b1a07cecc' (legacy backward compatibility)
    capturedHeaders = {};
    const genRaw = await client.generate(rawRoutingId, { prompt: 'Hi raw' });
    assert.equal(genRaw.text, 'Answer from 3.5 Flash-Lite');
    const modelHeaderRaw = capturedHeaders['x-goog-ext-525001261-jspb'];
    assert.ok(modelHeaderRaw);
    const parsedHeaderRaw = JSON.parse(modelHeaderRaw);
    assert.equal(parsedHeaderRaw[4], rawRoutingId);

    // 3. Both colliding models with same first 8 chars resolve to their respective raw wire IDs
    capturedHeaders = {};
    await client.generate('gemini-3.8-flash-1111222233334444', { prompt: 'Hi colA' });
    const parsedHeaderColA = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(parsedHeaderColA[4], rawCollidingA);

    capturedHeaders = {};
    await client.generate('gemini-3.8-flash-11112222aaaaaaaa', { prompt: 'Hi colB' });
    const parsedHeaderColB = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(parsedHeaderColB[4], rawCollidingB);

    // 4. Unknown model ID fails before generate POST with GeminiWebError('model')
    await assert.rejects(
      client.generate('non-existent-model', { prompt: 'Hi fail' }),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'model',
    );

    // 5. Thinking levels: medium (4) and high (2), and prompt hook cannot override thinking level
    let lastCapturedBody = '';
    const mockThinkingFetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/u/0/app?hl=en')) {
        return new Response(makeSyntheticBootstrapHtml('token_naming', 'bl_naming', 'sid_naming'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.includes('/StreamGenerate')) {
        lastCapturedBody = String(init?.body);
        new Headers(init?.headers as any).forEach((val, key) => {
          capturedHeaders[key] = val;
        });
        return new Response(makeSyntheticGenerationPayload('Answer with thinking'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const clientThinking = createGeminiWebClient(store, { fetch: mockThinkingFetch });

    // Medium effort -> wire 4
    capturedHeaders = {};
    await clientThinking.generate('gemini-3.5-flash-lite', { prompt: 'Test medium' }, {
      thinkingLevel: 'medium',
      onPayload: (p) => ({ prompt: 'Modified prompt' }),
    });
    const headerMed = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(headerMed[16], 4); // 15 + (13 - 12) = 16
    const innerMed = JSON.parse(JSON.parse(new URLSearchParams(lastCapturedBody).get('f.req')!)[1]);
    assert.equal(innerMed[80], 4);
    assert.deepEqual(innerMed[0], ['Modified prompt']); // Prompt hook modified prompt, but wire thinking remains 4

    // High effort -> wire 2
    capturedHeaders = {};
    await clientThinking.generate('gemini-3.5-flash-lite', { prompt: 'Test high' }, { thinkingLevel: 'high' });
    const headerHigh = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(headerHigh[16], 2);
    const innerHigh = JSON.parse(JSON.parse(new URLSearchParams(lastCapturedBody).get('f.req')!)[1]);
    assert.equal(innerHigh[80], 2);

    // Unsupported thinking level rejected before network
    await assert.rejects(
      clientThinking.generate('gemini-3.5-flash-lite', { prompt: 'Test invalid' }, { thinkingLevel: 'off' as any }),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'unsupported',
    );
    await assert.rejects(
      clientThinking.generate('gemini-3.5-flash-lite', { prompt: 'Test invalid' }, { thinkingLevel: 'xhigh' as any }),
      (err: unknown) => err instanceof GeminiWebError && err.code === 'unsupported',
    );
  });
});
