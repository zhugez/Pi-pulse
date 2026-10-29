// Ported from code-yeongyu/pi-comment-checker (MIT) — see NOTICE.md.
// Upstream tests use vitest; this repo uses node:test, so the assertions are
// translated 1:1 and the given/when/then cases are preserved.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PROCESS_OUTPUT_BYTES,
  PROCESS_TIMEOUT_MS,
  type ProcessExecutor,
  runCommentChecker,
  spawnProcess,
} from '../extensions/comment-checker/cli.ts';
import {
  extractCommentCheckRequests,
  isToolFailureOutput,
  type CommentCheckerHookInput,
  type ToolResultLike,
  toHookInput,
} from '../extensions/comment-checker/core.ts';
import { createCommentCheckerToolResultHandler } from '../extensions/comment-checker/index.ts';
import { COMMENT_CHECKER_WIDGET_KEY, getCommentCheckerWidgetLines } from '../extensions/comment-checker/ui.ts';

const WIDGET_CALL = [COMMENT_CHECKER_WIDGET_KEY, undefined, { placement: 'aboveEditor' }];

function makeContext() {
  const widgetCalls: unknown[] = [];
  return {
    cwd: '/workspace',
    sessionManager: { getSessionId: () => 'session-1' },
    ui: {
      setWidget: (key: string, lines: string[] | undefined, options?: unknown) => {
        widgetCalls.push([key, lines, options]);
      },
    },
    widgetCalls,
  };
}

function makeHookInput(): CommentCheckerHookInput {
  return {
    session_id: 'session-1',
    tool_name: 'Write',
    transcript_path: '',
    cwd: '/workspace',
    hook_event_name: 'PostToolUse',
    tool_input: { file_path: 'src/example.ts', content: 'const value = 1;\n' },
  };
}

// --- core: request extraction ---------------------------------------------

test('comment-checker: write result maps content to a Write hook input', () => {
  const requests = extractCommentCheckRequests({
    toolName: 'write',
    input: { filePath: 'src/example.ts', content: 'const value = 1;\n' },
    content: [{ type: 'text', text: 'wrote src/example.ts' }],
    isError: false,
  });
  assert.deepEqual(requests, [
    {
      sourceToolName: 'write',
      toolName: 'Write',
      filePath: 'src/example.ts',
      toolInput: { file_path: 'src/example.ts', content: 'const value = 1;\n' },
    },
  ]);
});

test('comment-checker: edit result maps old and new strings to an Edit hook input', () => {
  const requests = extractCommentCheckRequests({
    toolName: 'edit',
    input: { path: 'src/example.ts', old_string: 'const value = 1;', new_string: 'const value = 2;' },
    content: [{ type: 'text', text: 'edited src/example.ts' }],
    isError: false,
  });
  assert.deepEqual(requests, [
    {
      sourceToolName: 'edit',
      toolName: 'Edit',
      filePath: 'src/example.ts',
      toolInput: {
        file_path: 'src/example.ts',
        old_string: 'const value = 1;',
        new_string: 'const value = 2;',
      },
    },
  ]);
});

test('comment-checker: multiedit result maps camelCase and snake_case edits', () => {
  const requests = extractCommentCheckRequests({
    toolName: 'multiedit',
    input: {
      file_path: 'src/example.ts',
      edits: [
        { old_string: 'const a = 1;', new_string: 'const a = 2;' },
        { oldString: 'const b = 1;', newString: 'const b = 2;' },
      ],
    },
    content: [{ type: 'text', text: 'edited src/example.ts' }],
    isError: false,
  });
  assert.deepEqual(requests, [
    {
      sourceToolName: 'multiedit',
      toolName: 'MultiEdit',
      filePath: 'src/example.ts',
      toolInput: {
        file_path: 'src/example.ts',
        edits: [
          { old_string: 'const a = 1;', new_string: 'const a = 2;' },
          { old_string: 'const b = 1;', new_string: 'const b = 2;' },
        ],
      },
    },
  ]);
});

test('comment-checker: apply_patch text maps add and update hunks', () => {
  const patch = `*** Begin Patch
*** Add File: src/added.ts
+// explain value
+const value = 1;
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-const before = 1;
+// explain next value
+const after = 2;
*** Delete File: src/deleted.ts
*** End Patch`;
  const requests = extractCommentCheckRequests({
    toolName: 'apply_patch',
    input: { input: patch },
    content: [{ type: 'text', text: 'add: src/added.ts\nupdate: src/old.ts -> src/new.ts' }],
    isError: false,
  });
  assert.deepEqual(requests, [
    {
      sourceToolName: 'apply_patch',
      toolName: 'Write',
      filePath: 'src/added.ts',
      toolInput: { file_path: 'src/added.ts', content: '// explain value\nconst value = 1;\n' },
    },
    {
      sourceToolName: 'apply_patch',
      toolName: 'Edit',
      filePath: 'src/new.ts',
      toolInput: {
        file_path: 'src/new.ts',
        old_string: 'const before = 1;\n',
        new_string: '// explain next value\nconst after = 2;\n',
      },
    },
  ]);
});

test('comment-checker: apply_patch OMO metadata uses full before/after content', () => {
  const event: ToolResultLike = {
    toolName: 'apply_patch',
    input: { input: '*** Begin Patch\n*** End Patch' },
    details: {
      files: [
        { filePath: 'src/added.ts', before: '', after: '// explain value\nconst value = 1;\n', type: 'add' },
        {
          filePath: 'src/old.ts',
          movePath: 'src/new.ts',
          before: 'const before = 1;\n',
          after: '// explain next value\nconst after = 2;\n',
          type: 'update',
        },
        { filePath: 'src/deleted.ts', before: '// old comment\n', after: '', type: 'delete' },
      ],
    },
    content: [{ type: 'text', text: 'apply_patch ok' }],
    isError: false,
  };
  const requests = extractCommentCheckRequests(event);
  assert.deepEqual(requests, [
    {
      sourceToolName: 'apply_patch',
      toolName: 'Write',
      filePath: 'src/added.ts',
      toolInput: { file_path: 'src/added.ts', content: '// explain value\nconst value = 1;\n' },
    },
    {
      sourceToolName: 'apply_patch',
      toolName: 'Edit',
      filePath: 'src/new.ts',
      toolInput: {
        file_path: 'src/new.ts',
        old_string: 'const before = 1;\n',
        new_string: '// explain next value\nconst after = 2;\n',
      },
    },
  ]);
});

test('comment-checker: failed tool output yields no work', () => {
  const requests = extractCommentCheckRequests({
    toolName: 'write',
    input: { filePath: 'src/example.ts', content: 'const value = 1;\n' },
    content: [{ type: 'text', text: 'Error: failed to write' }],
    isError: false,
  });
  assert.deepEqual(requests, []);
  assert.equal(isToolFailureOutput('Could not apply patch'), true);
});

test('comment-checker: toHookInput carries session and cwd', () => {
  const [request] = extractCommentCheckRequests({
    toolName: 'write',
    input: { filePath: 'src/example.ts', content: 'const value = 1;\n' },
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  });
  assert.ok(request);
  assert.deepEqual(toHookInput(request, { sessionId: 'session-1', cwd: '/workspace' }), {
    session_id: 'session-1',
    tool_name: 'Write',
    transcript_path: '',
    cwd: '/workspace',
    hook_event_name: 'PostToolUse',
    tool_input: { file_path: 'src/example.ts', content: 'const value = 1;\n' },
  });
});

// --- index: tool_result handler -------------------------------------------

test('comment-checker: warning appends checker text and keeps the widget hidden', async () => {
  const calls: CommentCheckerHookInput[] = [];
  const handler = createCommentCheckerToolResultHandler({
    run: async (input) => {
      calls.push(input);
      return { status: 'warning', message: 'COMMENT DETECTED', binaryPath: '/bin/comment-checker', exitCode: 2 };
    },
  });
  const ctx = makeContext();

  const result = await handler(
    {
      toolName: 'write',
      input: { filePath: 'src/example.ts', content: '// explain value\nconst value = 1;\n' },
      content: [{ type: 'text', text: 'wrote src/example.ts' }],
      isError: false,
    },
    ctx,
  );

  assert.deepEqual(calls, [
    toHookInput(
      extractCommentCheckRequests({
        toolName: 'write',
        input: { filePath: 'src/example.ts', content: '// explain value\nconst value = 1;\n' },
      })[0]!,
      { sessionId: 'session-1', cwd: '/workspace' },
    ),
  ]);
  assert.deepEqual(result?.content, [
    { type: 'text', text: 'wrote src/example.ts' },
    { type: 'text', text: '\n\nCOMMENT DETECTED' },
  ]);
  assert.deepEqual(ctx.widgetCalls, [WIDGET_CALL]);
});

test('comment-checker: missing binary leaves tool output untouched', async () => {
  const handler = createCommentCheckerToolResultHandler({
    run: async () => ({ status: 'missing', message: 'missing' }),
  });
  const ctx = makeContext();
  const result = await handler(
    {
      toolName: 'write',
      input: { filePath: 'src/example.ts', content: 'const value = 1;\n' },
      content: [{ type: 'text', text: 'wrote src/example.ts' }],
      isError: false,
    },
    ctx,
  );
  assert.equal(result, undefined);
  assert.deepEqual(ctx.widgetCalls, [WIDGET_CALL]);
});

test('comment-checker: clean and error results leave tool output untouched', async () => {
  const event: ToolResultLike = {
    toolName: 'write',
    input: { filePath: 'src/example.ts', content: 'const value = 1;\n' },
    content: [{ type: 'text', text: 'wrote src/example.ts' }],
    isError: false,
  };

  for (const run of [
    async () => ({ status: 'pass' as const, message: '', binaryPath: '/bin/comment-checker', exitCode: 0 }),
    async () => ({ status: 'error' as const, message: 'checker crashed' }),
  ]) {
    const ctx = makeContext();
    const result = await createCommentCheckerToolResultHandler({ run })(event, ctx);
    assert.equal(result, undefined);
    assert.deepEqual(ctx.widgetCalls, [WIDGET_CALL]);
  }
});

test('comment-checker: non-edit tools are ignored without invoking the checker', async () => {
  let called = false;
  const handler = createCommentCheckerToolResultHandler({
    run: async () => {
      called = true;
      return { status: 'pass', message: '' };
    },
  });
  const result = await handler(
    { toolName: 'read', input: { path: 'a.ts' }, content: [], isError: false },
    makeContext(),
  );
  assert.equal(result, undefined);
  assert.equal(called, false);
});

test('comment-checker: widget stays hidden in every state', () => {
  assert.equal(COMMENT_CHECKER_WIDGET_KEY, 'pi-comment-checker');
  for (const state of [
    { status: 'loading' as const, checkedFiles: [], warnings: [] },
    { status: 'missing' as const, checkedFiles: [], warnings: [] },
    { status: 'clean' as const, checkedFiles: [], warnings: [] },
    { status: 'warning' as const, checkedFiles: ['a.ts'], warnings: [{ filePath: 'a.ts', message: 'x' }] },
    { status: 'error' as const, checkedFiles: [], warnings: [], errorMessage: 'boom' },
  ]) {
    assert.equal(getCommentCheckerWidgetLines(state), undefined);
  }
});

// --- cli: process boundary ------------------------------------------------

test('comment-checker: exit zero returns pass and sends hook JSON on stdin', async () => {
  const input = makeHookInput();
  const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
  const executor: ProcessExecutor = async (command, args, stdin) => {
    calls.push({ command, args, stdin });
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const result = await runCommentChecker(input, { binaryPath: '/bin/comment-checker', executor });

  assert.deepEqual(result, {
    status: 'pass',
    message: '',
    binaryPath: '/bin/comment-checker',
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
  assert.deepEqual(calls, [{ command: '/bin/comment-checker', args: ['check'], stdin: JSON.stringify(input) }]);
});

test('comment-checker: exit two returns a warning with the stderr message', async () => {
  const executor: ProcessExecutor = async () => ({ exitCode: 2, stdout: '', stderr: 'COMMENT DETECTED' });
  const result = await runCommentChecker(makeHookInput(), { binaryPath: '/bin/comment-checker', executor });
  assert.equal(result.status, 'warning');
  assert.equal(result.message, 'COMMENT DETECTED');
});

test('comment-checker: custom prompt forwards the --prompt flag', async () => {
  const calls: string[][] = [];
  const executor: ProcessExecutor = async (_command, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  await runCommentChecker(makeHookInput(), {
    binaryPath: '/bin/comment-checker',
    customPrompt: 'Fix this {{comments}}',
    executor,
  });
  assert.deepEqual(calls, [['check', '--prompt', 'Fix this {{comments}}']]);
});

test('comment-checker: missing binary short-circuits without spawning', async () => {
  let called = false;
  const executor: ProcessExecutor = async () => {
    called = true;
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const result = await runCommentChecker(makeHookInput(), { resolveBinary: () => undefined, executor });
  assert.equal(result.status, 'missing');
  assert.equal(called, false);
});

test('comment-checker: process output is capped and the cap is reported', async () => {
  const maxOutputBytes = 16;
  assert.ok(MAX_PROCESS_OUTPUT_BYTES > maxOutputBytes);
  const result = await spawnProcess(
    process.execPath,
    ['-e', "process.stderr.write('x'.repeat(40)); process.exit(2);"],
    '',
    maxOutputBytes,
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, `${'x'.repeat(maxOutputBytes)}\n[stderr truncated after ${maxOutputBytes} bytes]`);
});

test('comment-checker: a multibyte character split by the cap is dropped, not mangled', async () => {
  const result = await spawnProcess(process.execPath, ['-e', "process.stderr.write('🙂'); process.exit(2);"], '', 1);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, '\n[stderr truncated after 1 bytes]');
});

test('comment-checker: a hanging process is killed and reported as a timeout', async () => {
  const processTimeoutMs = 50;
  assert.ok(PROCESS_TIMEOUT_MS > processTimeoutMs);
  const result = await spawnProcess(
    process.execPath,
    ['-e', "process.stderr.write('started'); setTimeout(() => {}, 10_000);"],
    '',
    1024,
    processTimeoutMs,
  );
  assert.equal(result.exitCode, null);
  assert.equal(result.stderr, `comment-checker process timed out after ${processTimeoutMs} ms`);
});
