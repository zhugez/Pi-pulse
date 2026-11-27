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
  const progressTitles: string[] = [];
  const state = {
    file: '/project with spaces/session;literal.jsonl' as string | undefined,
    leaf: 'selected-tip' as string | null,
    reads: 0,
  };
  const controller = new AbortController();
  const events = new Map<string, () => void>();
  let cancelProgress: (() => void) | undefined;
  const ctx: Pick<ExtensionCommandContext, 'cwd' | 'hasUI' | 'signal'> & {
    sessionManager: Pick<ExtensionCommandContext['sessionManager'], 'getSessionFile' | 'getLeafId'>;
    ui: Pick<ExtensionCommandContext['ui'], 'select' | 'notify' | 'editor'>;
  } = {
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
      select: (title, _options, options) => {
        progressTitles.push(title);
        assert.ok(options?.signal);
        const signal = options.signal;
        return new Promise<undefined>((resolve) => {
          cancelProgress = () => resolve(undefined);
          signal.addEventListener('abort', cancelProgress, { once: true });
          if (signal.aborted) cancelProgress();
        });
      },
      notify: (message, level = 'info') => {
        notices.push([message, level]);
      },
      editor: async (title, text = '') => {
        reports.push([title, text]);
        return undefined;
      },
    },
  };
  const api: Pick<ExtensionAPI, 'on' | 'registerCommand'> = {
    on: (event: string, listener: (...args: never[]) => unknown) => {
      events.set(event, listener);
      return () => {
        events.delete(event);
      };
    },
    registerCommand: (name, command) => {
      commands.set(name, command);
    },
  };
  registerTraceveil(api as ExtensionAPI, async (...args) => {
    calls.push(args);
    return execute ? execute(...args) : { stdout: '\u001b[31mreport\u001b[0m\n', stderr: '' };
  });
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
    progressTitles,
    run: (args = '') => command.handler(args, ctx as ExtensionCommandContext),
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
  const h = harness(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
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
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let child: ReturnType<typeof execFile> | undefined;
  const h = harness(async (_binary, _args, options) => {
    const execution = promisify(execFile)(
      process.execPath,
      ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);'],
      options,
    );
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
    const h = harness(
      () =>
        new Promise((resolve, reject) => {
          finish = () => (fails ? reject({ code: 2 }) : resolve({ stdout: 'old report', stderr: '' }));
        }),
    );
    const manager = h.ctx.sessionManager;
    Object.defineProperty(h.ctx, 'sessionManager', {
      get() {
        assert.equal(stale, false, 'The replaced context must not be queried');
        return manager;
      },
    });
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

for (const field of ['binary', 'file', 'leaf'] as const) {
  test(`Traceveil rejects control-bearing ${field} before progress or execution`, async () => {
    const previousBinary = process.env.TRACEVEIL_BIN;
    try {
      for (const control of [
        '\u0000',
        '\t',
        '\n',
        '\r',
        '\u001b]0;untrusted\u0007',
        '\u007f',
        '\u0085',
        '\u009b',
        '\u009d',
      ]) {
        for (const mode of field === 'binary' ? ['', 'demo', 'doctor'] : ['']) {
          const h = harness();
          const rejected = field === 'leaf' ? `leaf${control}untrusted` : `/untrusted${control}/traceveil`;
          process.env.TRACEVEIL_BIN = field === 'binary' ? rejected : '/tools/traceveil';
          if (field === 'file') h.state.file = rejected;
          if (field === 'leaf') h.state.leaf = rejected;
          await h.run(mode);
          assert.equal(h.calls.length, 0);
          assert.deepEqual(h.progressTitles, []);
          assert.deepEqual(h.reports, []);
          assert.equal(h.events.size, 0);
          assert.deepEqual(h.notices, [
            ['Traceveil paths and leaf IDs must not contain control characters.', 'warning'],
          ]);
          assert.equal(h.notices.flat().join(' ').includes(rejected), false);
        }
      }
    } finally {
      if (previousBinary === undefined) delete process.env.TRACEVEIL_BIN;
      else process.env.TRACEVEIL_BIN = previousBinary;
    }
  });
}

test('Traceveil withholds a completed inspection command containing controls', async () => {
  const h = harness(async () => ({
    stdout:
      "Inspection template (join wrapped lines):\n  traceveil inspect '@scope:f001' SESSION --agent pi\t--rule-threshold READ001=4",
    stderr: '',
  }));
  await h.run();
  assert.equal(h.reports.length, 1);
  assert.match(h.reports[0][1], /Inspection command withheld because it contains control characters/);
  assert.doesNotMatch(h.reports[0][1], /traceveil inspect|\t/);
});

test(
  'Traceveil emits a runnable inspection command preserving source, leaf and policy',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = mkdtempSync(join(process.cwd(), '.traceveil-command-'));
    const previousBinary = process.env.TRACEVEIL_BIN;
    try {
      const binary = join(directory, "traceveil 日本語\u200d 'literal;tool");
      writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n', {
        mode: 0o755,
      });
      process.env.TRACEVEIL_BIN = binary;
      const h = harness(async () => ({
        stdout: `Inspection template (join wrapped lines):\n  traceveil inspect '@scope:f001' SESSION --agent pi\n    --rule-threshold READ001=4\n  Replace SESSION with the exact file, or --stdin with the same bytes.\n  Repeat --leaf ID if one was selected. Policy above is pinned.`,
        stderr: '',
      }));
      h.state.file = join(directory, "session tiếng Việt\u200c 'quote;literal.jsonl");
      h.state.leaf = "leaf 日本語\u200d 'literal;tip";
      await h.run();
      assert.equal(h.calls[0][0], binary);
      assert.deepEqual(h.calls[0][1], [
        'analyze',
        '--color',
        'never',
        '--agent',
        'pi',
        '--leaf',
        h.state.leaf,
        '--',
        h.state.file,
      ]);
      assert.equal(h.progressTitles.length, 1);
      assert.deepEqual(h.notices, []);
      const report = h.reports[0][1];
      assert.match(report, /Inspection command \(join wrapped lines\):/);
      const command = report.split('\n').slice(1).join(' ').trim();
      assert.ok(command.includes(' inspect '));
      assert.doesNotMatch(command, /\p{Cc}/u);
      const result = await promisify(execFile)('/bin/sh', ['-c', command]);
      assert.deepEqual(JSON.parse(result.stdout), [
        'inspect',
        '@scope:f001',
        h.state.file,
        '--agent',
        'pi',
        '--leaf',
        h.state.leaf,
        '--rule-threshold',
        'READ001=4',
      ]);
      assert.doesNotMatch(report, /SESSION|Repeat --leaf/);
    } finally {
      if (previousBinary === undefined) delete process.env.TRACEVEIL_BIN;
      else process.env.TRACEVEIL_BIN = previousBinary;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
