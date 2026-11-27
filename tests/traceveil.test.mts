import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import registerTraceveil from '../extensions/traceveil/index.ts';

type Execute = NonNullable<Parameters<typeof registerTraceveil>[1]>;
function harness(execute?: Execute) {
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const calls: Parameters<Execute>[] = [];
  const reports: string[][] = [];
  const notices: string[][] = [];
  const state = {
    file: '/project with spaces/session;literal.jsonl' as string | undefined,
    leaf: 'selected-tip' as string | null,
    reads: 0,
  };
  const controller = new AbortController();
  const ctx = {
    cwd: '/project with spaces',
    hasUI: true,
    signal: controller.signal,
    sessionManager: {
      getSessionFile: () => {
        state.reads++;
        return state.file;
      },
      getLeafId: () => {
        state.reads++;
        return state.leaf;
      },
    },
    ui: {
      notify: (message: string, level: string) => {
        notices.push([message, level]);
      },
      editor: async (title: string, text: string) => {
        reports.push([title, text]);
        return undefined;
      },
    },
  };
  registerTraceveil(
    {
      registerCommand: (name, command) => {
        commands.set(name, command);
      },
    } as ExtensionAPI,
    async (...args) => {
      calls.push(args);
      return execute ? execute(...args) : { stdout: '\u001b[31mreport\u001b[0m\n', stderr: '' };
    },
  );
  const command = commands.get('traceveil');
  assert.ok(command);
  return {
    state,
    ctx,
    controller,
    calls,
    reports,
    notices,
    run: (args = '') => command.handler(args, ctx as unknown as ExtensionCommandContext),
  };
}

test('Traceveil is on demand, uses literal current-source/current-leaf arguments and displays only through UI', async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.reads, 0);
  await h.run();
  const [binary, argv, options] = h.calls[0];
  assert.ok(binary.endsWith(process.platform === 'win32' ? 'traceveil.exe' : 'traceveil'));
  assert.deepEqual(argv, [
    'analyze',
    '--color',
    'never',
    '--agent',
    'pi',
    '--leaf',
    'selected-tip',
    '--',
    h.state.file,
  ]);
  assert.equal(options.cwd, h.ctx.cwd);
  assert.equal(options.timeout, 30_000);
  assert.equal(options.maxBuffer, 256 * 1024);
  assert.equal(options.killSignal, 'SIGKILL');
  assert.equal(options.signal, h.controller.signal);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0][1], 'report');
  assert.equal(h.notices.length, 0);
});

test('Traceveil demo and doctor do not resolve session data; invalid or unsaved requests never execute', async () => {
  for (const mode of ['demo', 'doctor']) {
    const h = harness();
    h.state.file = undefined;
    h.state.leaf = null;
    await h.run(mode);
    assert.deepEqual(h.calls[0][1], [mode, '--color', 'never']);
    assert.equal(h.state.reads, 0);
  }
  for (const args of ['help', '--help', 'inspect f001', 'demo extra', 'analyze /other/session', '; touch untrusted']) {
    const h = harness();
    await h.run(args);
    assert.equal(h.calls.length, 0);
    assert.equal(h.state.reads, 0);
    assert.equal(h.notices.length, 1);
  }
  for (const missing of ['file', 'leaf'] as const) {
    const h = harness();
    if (missing === 'file') h.state.file = undefined;
    else h.state.leaf = null;
    await h.run();
    assert.equal(h.calls.length, 0);
    assert.match(h.notices[0][0], /No saved Pi branch/);
  }
  const headless = harness();
  headless.ctx.hasUI = false;
  await assert.rejects(headless.run(), /outside interactive Pi/);
  assert.equal(headless.calls.length, 0);
});

test('Traceveil discards stale, cancelled and incomplete output and keeps failures in UI', async () => {
  const changed = harness(async () => {
    changed.state.leaf = 'another-branch';
    return { stdout: 'old report', stderr: '' };
  });
  await changed.run();
  assert.equal(changed.reports.length, 0);
  assert.match(changed.notices[0][0], /branch changed/);
  for (const failure of [
    { code: 'ENOENT' },
    { code: 'ABORT_ERR' },
    { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
    { killed: true },
  ]) {
    const h = harness(async () => {
      throw { ...failure, stdout: 'private incomplete output' };
    });
    await h.run();
    assert.equal(h.reports.length, 0);
    assert.equal(h.notices.length, 1);
    assert.doesNotMatch(h.notices[0][0], /private incomplete/);
  }
  const failure = harness(async () => {
    throw { code: 2, stderr: 'SOURCE_CHANGED: retry when stable' };
  });
  await failure.run();
  assert.match(failure.reports[0][0], /failed/);
  assert.match(failure.reports[0][1], /SOURCE_CHANGED/);
  const empty = harness(async () => ({ stdout: '', stderr: '' }));
  await empty.run();
  assert.equal(empty.reports.length, 0);
  assert.match(empty.notices[0][0], /no report/);
});
