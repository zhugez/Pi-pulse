// /home/dev/pi-pulse/tests/ponytail.test.mts
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import registerPonytail, { buildGateSnapshot } from '../extensions/ponytail/index.js';

test('ponytail: registers /pnt-opt alias alongside upstream ponytail commands', async () => {
  const commands = new Map<string, any>();
  const sentMessages: Array<{ text: string; options: any }> = [];

  const fakePi: any = {
    registerCommand: (name: string, def: any) => commands.set(name, def),
    on: () => {},
    appendEntry: () => {},
    sendUserMessage: (text: string, options?: any) => {
      sentMessages.push({ text, options });
    },
  };

  registerPonytail(fakePi);

  assert.ok(commands.has('ponytail'));
  assert.ok(commands.has('ponytail-audit'));
  assert.ok(commands.has('pnt-opt'));

  await commands.get('pnt-opt').handler('', { isIdle: () => true });
  await commands.get('pnt-opt').handler('extensions/', { isIdle: () => false, ui: { notify() {} } });

  assert.deepEqual(sentMessages, [
    { text: '/skill:ponytail-audit', options: { expandPromptTemplates: true } },
    {
      text: '/skill:ponytail-audit extensions/',
      options: { deliverAs: 'followUp', expandPromptTemplates: true },
    },
  ]);
});

// --- gate snapshot: the audit starts from crapper numbers, not from opinion ---

const FAKE_TABLE = `CRAP Report
===========

Function        Namespace    CC    Cov%     CRAP
------------------------------------------------------
worst           demo.core    14   N/A       N/A
second          demo.core    11   N/A       N/A
third           demo.core     9   N/A       N/A
fourth          demo.core     8   N/A       N/A
fifth           demo.core     7   N/A       N/A
sixth           demo.core     6   N/A       N/A
`;

async function withFakeCrapper(run: (binary: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pulse-pnt-'));
  const saved = process.env.PI_CRAPPER;
  try {
    const binary = join(dir, 'crapper');
    await writeFile(binary, `#!/usr/bin/env bash\ncat <<'REPORT'\n${FAKE_TABLE}REPORT\n`, 'utf8');
    await chmod(binary, 0o755);
    process.env.PI_CRAPPER = binary;
    await run(binary);
  } finally {
    if (saved === undefined) delete process.env.PI_CRAPPER;
    else process.env.PI_CRAPPER = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

test('ponytail: the snapshot is skipped without a working directory', async () => {
  assert.equal(await buildGateSnapshot(undefined, ''), undefined);
});

test('ponytail: the snapshot is skipped when crapper is not installed', async () => {
  const saved = process.env.PI_CRAPPER;
  const savedPath = process.env.PATH;
  try {
    process.env.PI_CRAPPER = '/nonexistent/crapper';
    process.env.PATH = '/nonexistent';
    assert.equal(await buildGateSnapshot('/tmp', ''), undefined);
  } finally {
    if (saved === undefined) delete process.env.PI_CRAPPER;
    else process.env.PI_CRAPPER = saved;
    process.env.PATH = savedPath;
  }
});

test('ponytail: the snapshot lists the worst functions and caps the tail', async () => {
  await withFakeCrapper(async () => {
    const snapshot = await buildGateSnapshot('/tmp', '');
    assert.ok(snapshot);
    assert.match(snapshot, /not a path/);
    assert.match(snapshot, /6 functions, worst first/);
    assert.match(snapshot, /CC=14 worst \(demo\.core\)/);
    assert.match(snapshot, /… 1 more/);
    assert.doesNotMatch(snapshot, /sixth/);
  });
});

test('ponytail: /pnt-opt hands the snapshot to the audit and keeps the path arg first', async () => {
  await withFakeCrapper(async () => {
    const commands = new Map<string, any>();
    const sent: string[] = [];
    registerPonytail({
      registerCommand: (name: string, def: any) => commands.set(name, def),
      on: () => {},
      appendEntry: () => {},
      sendUserMessage: (text: string) => sent.push(text),
    } as any);

    await commands.get('pnt-opt').handler('extensions/', { isIdle: () => true, cwd: '/tmp' });

    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /^\/skill:ponytail-audit extensions\/\n\n## Gate snapshot/);
    assert.match(sent[0]!, /CC=14 worst/);
  });
});
