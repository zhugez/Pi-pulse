import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNumesPoolFetch } from '../extensions/numes-pool/index.ts';

const url = 'https://api.numes.ai/api/v1/chat/completions';
const request = { method: 'POST', body: '{}' };
const keys = ['sk-numes-v1-aaa', 'sk-numes-v1-bbb', 'sk-numes-v1-ccc'];
const auth = (key: string) => `Bearer ${key}`;

function mockPool(reply: (key: string | null) => Response, now?: () => number) {
  const attempts: (string | null)[] = [];
  const fetch = createNumesPoolFetch(
    keys,
    now,
  )(async (input, init) => {
    assert.equal(String(input), url);
    assert.equal(init?.redirect, 'error');
    const key = new Headers(init?.headers).get('authorization');
    attempts.push(key);
    return reply(key);
  });
  return { attempts, fetch, run: () => fetch(url, request) };
}

test('Numes rotates keys and does not sign requests to other destinations', async () => {
  const { attempts, fetch, run } = mockPool(() => new Response('ok'));
  await assert.rejects(fetch(url + '?q=1', request), /unexpected request/);
  await assert.rejects(fetch('https://example.invalid', request), /unexpected request/);
  for (let i = 0; i < 4; i++) assert.equal(await (await run()).text(), 'ok');
  assert.deepEqual(attempts, [...keys, keys[0]].map(auth));
});

test('Numes fails over on 401 and skips rejected keys until reload', async () => {
  const { attempts, run } = mockPool((key) =>
    key === auth(keys[0]) ? new Response(key, { status: 401 }) : new Response('ok'),
  );
  for (let i = 0; i < 4; i++) assert.equal((await run()).status, 200);
  assert.deepEqual(attempts, [keys[0], keys[1], keys[1], keys[2], keys[1]].map(auth));
  const exhausted = mockPool((key) => new Response(key, { status: 401 }));
  assert.match(await (await exhausted.run()).text(), /All Numes Pool keys were rejected/);
  assert.equal((await exhausted.run()).status, 401);
  assert.deepEqual(exhausted.attempts, keys.map(auth));
});

test('Numes stops the pool on 429, respects Retry-After, and redacts upstream errors', async () => {
  let time = 0;
  let first = true;
  const { attempts, run } = mockPool(
    (key) => {
      const status = first ? 429 : 403;
      first = false;
      return new Response(key, { status, headers: { 'Retry-After': '20', 'X-Upstream-Debug': key ?? '' } });
    },
    () => time,
  );
  const limited = await run();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '20');
  assert.equal(limited.headers.get('X-Upstream-Debug'), null);
  assert.match(await limited.text(), /Numes rate limit reached/);
  assert.equal((await run()).status, 429);
  assert.deepEqual(attempts, [auth(keys[0])]);
  time = 20_000;
  const denied = await run();
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('X-Upstream-Debug'), null);
  assert.equal(await denied.text(), '{"error":{"message":"Numes request failed (HTTP 403)."}}');
  assert.deepEqual(attempts, [auth(keys[0]), auth(keys[2])]);
});

test('Pi discovers the packaged Numes Pool and checks private key file permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-pulse-numes-'));
  try {
    const packages = [
      { source: process.cwd(), extensions: ['extensions/numes-pool/index.ts'], skills: [], prompts: [], themes: [] },
    ];
    const providers = {
      'numes-pool': {
        baseUrl: 'https://api.numes.ai/api/v1',
        api: 'openai-completions',
        apiKey: 'numes-pool-managed',
        models: [{ id: 'fixture-model' }],
      },
    };
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages }));
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers }));
    const path = join(dir, 'numes-pool.keys');
    writeFileSync(path, keys.join('\n'), { mode: 0o600 });
    const list = () => {
      const result = spawnSync(process.env.PI_BIN ?? 'pi', ['--offline', '--list-models', 'numes-pool'], {
        cwd: dir,
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          PI_CODING_AGENT_DIR: dir,
          PI_AGENT_DIR: dir,
          PI_OFFLINE: '1',
        },
        timeout: 20_000,
        encoding: 'utf8',
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result;
    };
    chmodSync(path, 0o644);
    const invalid = list();
    assert.match(invalid.stderr + invalid.stdout, /Invalid numes-pool\.keys/);
    chmodSync(path, 0o600);
    const valid = list();
    assert.doesNotMatch(valid.stderr, /Failed to load extension|Invalid numes-pool\.keys/);
    assert.match(valid.stdout, /^numes-pool\s+fixture-model\b/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
