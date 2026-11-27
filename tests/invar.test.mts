import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  BoundaryResult,
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from '@earendil-works/pi-coding-agent';

import invar from '../extensions/invar/index.ts';

type Handler = (event: Record<string, unknown>, ctx: ExtensionCommandContext) => Promise<BoundaryResult | void>;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('invar: approval, verification, bounded repair, and pinned inputs', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pi-pulse-invar-'));
  const prior = {
    agent: process.env.PI_CODING_AGENT_DIR,
    binary: process.env.INVAR_BIN,
    auto: process.env.PI_INVAR_AUTO_SETUP,
  };
  const binary = join(temporary, 'invar');
  const agent = join(temporary, 'agent');
  const disabled = join(agent, 'invar', `${digest(Buffer.from(temporary))}.json.disabled`);
  const config = join(temporary, 'invar.json');
  const candidate = join(temporary, '.invar', 'candidate.json');
  const accepted = join(temporary, '.invar', 'accepted.json');
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.INVAR_BIN = binary;
  delete process.env.PI_INVAR_AUTO_SETUP;
  await writeFile(binary, 'reviewed executable');
  let behavior = 'before\n';
  let executions = 0;
  let override: Partial<ExecResult> | undefined;
  const options = { capture: false, approve: false, trusted: true, editReview: false };
  const notices: string[] = [];
  const questions: string[] = [];
  const messages: string[] = [];
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Omit<RegisteredCommand, 'name' | 'sourceInfo'>>();
  const ctx = {
    cwd: temporary,
    hasUI: true,
    waitForIdle: async () => {},
    isProjectTrusted: () => options.trusted,
    ui: {
      setStatus: () => {},
      notify: (message: string) => notices.push(message),
      input: async () => '["node", "report.mjs"]',
      editor: async (title: string, text: string) =>
        options.editReview && title.startsWith('Review captured') ? `${text}changed` : text,
      confirm: async (title: string) => {
        questions.push(title);
        return title === 'Save configuration and capture?' ? options.capture : options.approve;
      },
    },
  } as unknown as ExtensionCommandContext;
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, command: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) =>
      commands.set(name, command),
    getAllTools: () => [
      { name: 'read', sourceInfo: { source: 'builtin' } },
      { name: 'lookup', annotations: { readOnlyHint: true } },
      { name: 'edit' },
    ],
    sendMessage: (message: { content: string }) => messages.push(message.content),
    exec: async (executable: string, args: string[], settings: { cwd: string }): Promise<ExecResult> => {
      executions++;
      assert.equal(executable, binary);
      assert.equal(settings.cwd, temporary);
      assert.deepEqual(args.slice(0, 3), ['--project', temporary, '--json']);
      const command = args[3];
      let status = 'ok';
      let code = 0;
      let identity: string | undefined;
      if (command === 'capture') {
        const snapshot = {
          config: JSON.parse(await readFile(config, 'utf8')),
          observations: [
            { id: 'main', exit_code: 0, stdout: { hex: Buffer.from(behavior).toString('hex') }, stderr: { hex: '' } },
          ],
        };
        await writeFile(candidate, JSON.stringify(snapshot));
        identity = digest(await readFile(candidate));
      } else if (command === 'lock') {
        assert.equal(args[4], '--candidate');
        assert.equal(args[5], digest(await readFile(candidate)));
        await copyFile(candidate, accepted);
      } else {
        assert.equal(command, 'verify');
        const snapshot = JSON.parse(await readFile(accepted, 'utf8'));
        status = snapshot.observations[0].stdout.hex === Buffer.from(behavior).toString('hex') ? 'pass' : 'regression';
        code = status === 'pass' ? 0 : 1;
      }
      return {
        code,
        stdout: JSON.stringify({ version: 1, command, status, exit_code: code, candidate_sha256: identity }),
        stderr: '',
        killed: false,
        truncated: false,
        ...override,
      };
    },
  };
  const emit = async (name: string, event: Record<string, unknown> = {}) =>
    handlers.get(name)?.({ type: name, ...event }, ctx);
  const dirty = (toolName = 'edit') => emit('tool_execution_end', { toolName });
  const boundary = (extra: Record<string, unknown> = {}) =>
    emit('agent_before_settle', { entries: [], continue: false, outcome: 'completed', ...extra });
  const content = (result: BoundaryResult | void) => {
    const entry = result?.entries?.at(-1);
    assert.equal(entry?.type, 'custom_message');
    assert.ok(entry && 'content' in entry && typeof entry.content === 'string');
    return entry.content;
  };
  try {
    invar(api as unknown as ExtensionAPI);
    const command = commands.get('invar');
    assert.ok(command);
    const run = (action: string) => command.handler(action, ctx);

    Object.assign(ctx, { hasUI: false });
    await emit('session_start');
    Object.assign(ctx, { hasUI: true });
    options.trusted = false;
    await emit('session_start');
    options.trusted = true;
    process.env.PI_INVAR_AUTO_SETUP = '0';
    await emit('session_start');
    delete process.env.PI_INVAR_AUTO_SETUP;
    process.env.INVAR_BIN = join(temporary, 'missing');
    await emit('session_start');
    process.env.INVAR_BIN = binary;
    assert.deepEqual(questions, []);
    await emit('session_start');
    assert.deepEqual(questions, ['Enable Invar for this project?']);
    await emit('session_start');
    assert.equal(questions.length, 1);
    assert.equal(await readFile(disabled, 'utf8'), 'disabled\n');
    assert.equal(executions, 0);

    await dirty();
    assert.equal(await boundary(), undefined);
    await run('setup');
    assert.equal(executions, 0);
    await assert.rejects(readFile(config), { code: 'ENOENT' });

    options.capture = true;
    await run('setup');
    assert.equal(executions, 1);
    await assert.rejects(readFile(accepted), { code: 'ENOENT' });
    await dirty();
    assert.equal(await boundary(), undefined);
    assert.equal(executions, 1);

    options.approve = true;
    await run('setup');
    assert.equal(executions, 4);
    assert.match(messages.at(-1)!, /Initial verification passed/);
    await assert.rejects(readFile(disabled), { code: 'ENOENT' });
    const promptsAfterSetup = questions.length;
    await emit('session_start');
    assert.equal(questions.length, promptsAfterSetup);
    const baseline = await readFile(accepted);
    const configuration = await readFile(config);
    const captured = await readFile(candidate);
    const savedName = (await readdir(join(agent, 'invar'))).find((name) => name.endsWith('.json'));
    assert.ok(savedName);
    const savedFile = join(agent, 'invar', savedName);
    const registration = await readFile(savedFile);

    const beforeReads = executions;
    await dirty('read');
    await dirty('lookup');
    assert.equal(await boundary(), undefined);
    assert.equal(executions, beforeReads);
    await dirty('bash');
    const other = { type: 'custom', customType: 'other-extension', data: {} };
    const pass = await boundary({ entries: [other] });
    assert.deepEqual(pass?.entries?.[0], other);
    assert.match(content(pass), /^Invar PASS/);
    assert.equal(pass?.continue, undefined);

    behavior = 'after\n';
    await dirty();
    const regression = await boundary();
    assert.match(content(regression), /"status":"regression"/);
    assert.equal(regression?.continue, true);
    assert.equal((await boundary())?.continue, undefined);
    assert.match(content(await boundary()), /Do not claim completion/);
    await emit('before_agent_start', { messageType: 'user' });
    assert.equal((await boundary())?.continue, true);
    behavior = 'before\n';
    await dirty('unannotated_custom_tool');
    assert.match(content(await boundary()), /^Invar PASS/);
    assert.deepEqual(await readFile(accepted), baseline);
    assert.deepEqual(await readFile(candidate), captured);
    assert.deepEqual(await readFile(config), configuration);

    for (const [file, original, label] of [
      [config, configuration, 'config'],
      [accepted, baseline, 'baseline'],
      [binary, Buffer.from('reviewed executable'), 'executable'],
    ] as const) {
      await writeFile(file, Buffer.concat([original, Buffer.from('\n')]));
      const before: number = executions;
      await dirty();
      assert.match(content(await boundary()), new RegExp(`Reviewed inputs changed: ${label}`));
      assert.equal(executions, before);
      await writeFile(file, original);
    }

    options.trusted = false;
    await dirty();
    const beforeUntrusted = executions;
    assert.match(content(await boundary()), /not trusted/);
    assert.equal(executions, beforeUntrusted);
    options.trusted = true;
    assert.equal(await boundary({ continue: true }), undefined);
    assert.equal(await boundary({ outcome: 'aborted' }), undefined);
    assert.equal(executions, beforeUntrusted);

    for (const reply of [{ stdout: '{}' }, { killed: true }, { truncated: true }]) {
      override = reply;
      await dirty();
      assert.match(content(await boundary()), /No passing verdict/);
    }
    override = undefined;
    options.editReview = true;
    await run('setup');
    assert.deepEqual(await readFile(accepted), baseline);
    assert.deepEqual(await readFile(savedFile), registration);

    await run('off');
    await dirty();
    const beforeOff = executions;
    assert.equal(await boundary(), undefined);
    assert.equal(executions, beforeOff);
    assert.deepEqual(await readFile(accepted), baseline);
    await assert.rejects(readFile(savedFile), { code: 'ENOENT' });
    const promptsAfterOff = questions.length;
    await emit('session_start');
    assert.equal(questions.length, promptsAfterOff);
    assert.equal(executions, beforeOff);
    await unlink(disabled);
    options.editReview = false;
    await emit('session_start');
    assert.equal(questions[promptsAfterOff], 'Enable Invar for this project?');
    assert.match(messages.at(-1)!, /Initial verification passed/);
    assert.ok(await readFile(savedFile));
    await run('off');
    assert.ok(!notices.some((message) => message.startsWith('Error:')), notices.join('\n'));
  } finally {
    if (prior.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior.agent;
    if (prior.binary === undefined) delete process.env.INVAR_BIN;
    else process.env.INVAR_BIN = prior.binary;
    if (prior.auto === undefined) delete process.env.PI_INVAR_AUTO_SETUP;
    else process.env.PI_INVAR_AUTO_SETUP = prior.auto;
    await rm(temporary, { recursive: true, force: true });
  }
});
