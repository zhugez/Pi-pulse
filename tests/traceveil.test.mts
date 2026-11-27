import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

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
  const events = new Map<string, () => void>();
  let cancelProgress: (() => void) | undefined;
  const ctx = {
    cwd: '/project with spaces',
    hasUI: true,
    signal: controller.signal as AbortSignal | undefined,
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
      select: (_title: string, _options: string[], options: { signal: AbortSignal }) =>
        new Promise<undefined>((resolve) => {
          cancelProgress = () => resolve(undefined);
          options.signal.addEventListener('abort', cancelProgress, { once: true });
          if (options.signal.aborted) cancelProgress();
        }),
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
      on: (event: string, listener: () => void) => {
        events.set(event, listener);
        return () => events.delete(event);
      },
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
    events,
    cancel: () => {
      assert.ok(cancelProgress, 'A progress dialog must expose idle cancellation');
      cancelProgress();
    },
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
  assert.equal(options.signal?.aborted, false);
  h.controller.abort();
  assert.equal(options.signal?.aborted, true);
  assert.equal(h.events.size, 0);
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
  const changedFailure = harness(async () => {
    changedFailure.state.leaf = 'another-branch';
    throw { code: 2, stderr: 'old branch failure' };
  });
  await changedFailure.run();
  assert.equal(changedFailure.reports.length, 0);
  assert.equal(changedFailure.notices.length, 0);
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
    assert.equal(h.events.size, 0);
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

test('Traceveil cancels idle commands and discards late successful output', async () => {
  let finish!: (result: { stdout: string; stderr: string }) => void;
  const h = harness(() => new Promise((resolve) => { finish = resolve; }));
  h.ctx.signal = undefined;
  const running = h.run('demo');
  h.cancel();
  await Promise.resolve();
  assert.equal(h.calls[0][2].signal?.aborted, true);
  finish({ stdout: 'late report', stderr: '' });
  await running;
  assert.equal(h.reports.length, 0);
  assert.equal(h.events.size, 0);
});

test('Traceveil idle cancellation terminates the native subprocess without displaying output', async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let child: ReturnType<typeof execFile> | undefined;
  const h = harness(async (_binary, _args, options) => {
    const execution = promisify(execFile)(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);'], options);
    child = execution.child;
    child.stdout!.once('data', ready);
    return execution;
  });
  h.ctx.cwd = process.cwd();
  h.ctx.signal = undefined;
  const running = h.run('demo');
  try {
    await started;
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    h.cancel();
    await running;
    await exited;
    assert.equal(h.reports.length, 0);
    assert.match(h.notices[0][0], /cancellation/);
    assert.equal(h.events.size, 0);
  } finally {
    child?.kill('SIGKILL');
  }
});

test('Traceveil suppresses stale context access on session replacement for success and failure', async () => {
  for (const fails of [false, true]) {
    let finish!: () => void;
    let stale = false;
    const h = harness(() => new Promise((resolve, reject) => {
      finish = () => fails ? reject({ code: 2 }) : resolve({ stdout: 'old report', stderr: '' });
    }));
    const manager = h.ctx.sessionManager;
    Object.defineProperty(h.ctx, 'sessionManager', { get() {
      assert.equal(stale, false, 'The replaced context must not be queried');
      return manager;
    } });
    const running = h.run();
    h.events.get('session_shutdown')?.();
    stale = true;
    finish();
    await running;
    assert.equal(h.calls[0][2].signal?.aborted, true);
    assert.equal(h.reports.length, 0);
    assert.equal(h.notices.length, 0);
    assert.equal(h.events.size, 0);
  }
});

test('Traceveil emits a runnable inspection command preserving source, leaf and policy', { skip: process.platform === 'win32' }, async () => {
  const directory = mkdtempSync(join(process.cwd(), '.traceveil-command-'));
  const previousBinary = process.env.TRACEVEIL_BIN;
  try {
    const binary = join(directory, "traceveil 'literal");
    writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
    process.env.TRACEVEIL_BIN = binary;
    const h = harness(async () => ({
      stdout: `Inspection template (join wrapped lines):\n  traceveil inspect '@scope:f001' SESSION --agent pi --rule-threshold READ001=4\n  Replace SESSION with the exact file, or --stdin with the same bytes.\n  Repeat --leaf ID if one was selected. Policy above is pinned.`,
      stderr: '',
    }));
    h.state.file = join(directory, "session 'quote;literal.jsonl");
    h.state.leaf = "leaf 'literal";
    await h.run();
    const report = h.reports[0][1];
    const command = report.split('\n').find((line) => line.includes(' inspect '));
    assert.ok(command);
    const result = await promisify(execFile)('/bin/sh', ['-c', command]);
    assert.deepEqual(JSON.parse(result.stdout), [
      'inspect', '@scope:f001', h.state.file, '--agent', 'pi', '--rule-threshold', 'READ001=4', '--leaf', h.state.leaf,
    ]);
    assert.doesNotMatch(report, /SESSION|Repeat --leaf/);
  } finally {
    if (previousBinary === undefined) delete process.env.TRACEVEIL_BIN;
    else process.env.TRACEVEIL_BIN = previousBinary;
    rmSync(directory, { recursive: true, force: true });
  }
});
