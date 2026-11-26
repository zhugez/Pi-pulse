import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  SessionEntry,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';

import registerFooter, { footerCwd, footerTotals, renderSessionFooter } from '../extensions/session-footer.ts';

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const colored = {
  fg: (color: string, text: string) =>
    '\x1b[' + (color === 'success' ? '32' : color === 'error' ? '31' : '36') + 'm' + text + '\x1b[39m',
  bold: (text: string) => '\x1b[1m' + text + '\x1b[22m',
};
const usage = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const assistant = (value: ReturnType<typeof usage>) =>
  ({ type: 'message', message: { role: 'assistant', usage: value } }) as unknown as SessionEntry;

function fixture() {
  const entries = [assistant(usage(1999950, 70900, 7990050)), assistant(usage(50, 100, 9950))];
  const statuses = new Map<string, string>();
  const ctx = {
    mode: 'tui',
    hasUI: true,
    model: { provider: 'xingchiapi', id: 'gpt-6.1-sol', reasoning: true, contextWindow: 1000000 },
    sessionManager: { getEntries: () => entries, getCwd: () => os.homedir(), getSessionName: () => undefined },
    modelRegistry: { getProvider: () => ({ auth: {} }), isUsingOAuth: () => false },
    getContextUsage: () => ({ tokens: 229000, percent: 22.9, contextWindow: 1000000 }),
  } as unknown as ExtensionContext;
  let unsubscribeCount = 0;
  let branchChanged = () => {};
  const data: ReadonlyFooterDataProvider = {
    getGitBranch: () => null,
    getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => statuses,
    onBranchChange(callback) {
      branchChanged = callback;
      return () => {
        unsubscribeCount++;
      };
    },
  };
  return { ctx, data, entries, statuses, changeBranch: () => branchChanged(), unsubscribed: () => unsubscribeCount };
}

test('footer totals include all billed entry types and use the latest prompt for cache hit', () => {
  const entries = [
    assistant(usage(10, 1, 20, 30, 1)),
    { type: 'usage', usage: usage(1, 2, 3, 4, 2) },
    { type: 'compaction', usage: usage(2, 3, 4, 5, 3) },
    { type: 'branch_summary', usage: usage(3, 4, 5, 6, 4) },
    { type: 'message', message: { role: 'toolResult', usage: usage(4, 5, 6, 7, 5) } },
    assistant(usage(10, 6, 60, 30, 6)),
  ] as SessionEntry[];
  assert.deepEqual(footerTotals(entries), {
    input: 30,
    output: 21,
    cacheRead: 98,
    cacheWrite: 82,
    cost: 21,
    cacheHit: 60,
  });
  assert.equal(footerTotals([...entries, assistant(usage())]).cacheHit, undefined);
  assert.equal(footerTotals([]).input, 0);
});

test('footer renders readable metrics, model and cwd without dropping data on resize', () => {
  const f = fixture();
  const expected = [
    'model    xingchiapi/gpt-6.1-sol   high reasoning',
    'tokens   2.0M in   71k out   8.0M cache read   last hit 99.5%',
    'context  22.9% of 1.0M   cwd ~',
  ];
  assert.deepEqual(renderSessionFooter(f.ctx, f.data, plain, 'high', 120), expected);
  assert.deepEqual(
    renderSessionFooter(f.ctx, f.data, colored as Pick<Theme, 'fg' | 'bold'>, 'high', 120).map(
      stripVTControlCharacters,
    ),
    expected,
  );
  for (let width = 1; width <= 120; width++) {
    const lines = renderSessionFooter(f.ctx, f.data, colored as Pick<Theme, 'fg' | 'bold'>, 'high', width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      'overflow at ' + width,
    );
    const text = lines.map(stripVTControlCharacters).join('').replaceAll(' ', '');
    for (const value of [
      'xingchiapi/gpt-6.1-sol',
      '2.0Min',
      '71kout',
      '8.0Mcacheread',
      'lasthit99.5%',
      '22.9%of1.0M',
      'cwd~',
    ])
      assert.ok(text.includes(value), value);
  }
  assert.deepEqual(renderSessionFooter(f.ctx, f.data, plain, 'high', 0), []);
  f.statuses.set('z', 'Z' + String.fromCharCode(10) + 'ready');
  f.statuses.set('a', 'alpha');
  assert.equal(renderSessionFooter(f.ctx, f.data, plain, 'high', 120).at(-1), 'alpha Z ready');
  f.entries.push(assistant(usage(100, 100)));
  const updated = renderSessionFooter(f.ctx, f.data, plain, 'high', 120).join(' ');
  assert.match(updated, /last hit 0.0%/);
});

test('footer keeps unknown context honest and only marks confirmed subscription billing', () => {
  const f = fixture();
  Object.assign(f.ctx, { getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 1000000 }) });
  assert.match(renderSessionFooter(f.ctx, f.data, plain, 'high', 120).join(' '), /pending of 1.0M/);
  Object.assign(f.ctx.modelRegistry, { isUsingOAuth: () => true });
  assert.doesNotMatch(renderSessionFooter(f.ctx, f.data, plain, 'high', 120).join(' '), /subscription/);
  Object.assign(f.ctx.modelRegistry, { getProvider: () => ({ auth: { oauth: { isSubscription: true } } }) });
  assert.match(renderSessionFooter(f.ctx, f.data, plain, 'high', 120).join(' '), /\$0.000 subscription/);
  Object.assign(f.ctx, { model: undefined, getContextUsage: () => undefined });
  assert.match(renderSessionFooter(f.ctx, f.data, plain, 'high', 120).join(' '), /no model.*pending/);
  assert.equal(footerCwd(os.homedir()), '~');
  assert.equal(footerCwd(path.join(os.homedir(), 'repo')), '~' + path.sep + 'repo');
  const outside = os.homedir() + '-other';
  assert.equal(footerCwd(outside), outside);
});

test('footer registration preserves status updates, restores native UI and disposes branch subscriptions', async () => {
  const f = fixture();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  let component: { render(width: number): readonly string[]; dispose?(): void } | undefined;
  const currentFooter = () => component;
  let paints = 0;
  let footerCalls = 0;
  Object.assign(f.ctx, {
    ui: {
      setFooter(factory: Parameters<ExtensionContext['ui']['setFooter']>[0]) {
        footerCalls++;
        component?.dispose?.();
        component = factory
          ? factory(
              {
                requestRender() {
                  paints++;
                },
              } as never,
              plain as Theme,
              f.data,
            )
          : undefined;
      },
      notify() {},
    },
  });
  registerFooter({
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => events.set(name, handler),
    registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) =>
      commands.set(name, command),
    getThinkingLevel: () => 'high',
  } as unknown as ExtensionAPI);
  await events.get('session_start')!({}, f.ctx);
  assert.equal(footerCalls, 0);
  await events.get('session_shutdown')!({}, f.ctx);
  assert.equal(footerCalls, 0);
  await commands.get('footer')!.handler('clean', f.ctx as ExtensionCommandContext);
  assert.ok(component);
  f.changeBranch();
  assert.equal(paints, 1);
  f.statuses.set('live-throughput', '42 tok/s');
  assert.ok(component.render(120).join(' ').includes('42 tok/s'));
  const next = { ...f.ctx, model: { ...f.ctx.model!, id: 'next-model' } } as ExtensionContext;
  await events.get('model_select')!({}, next);
  assert.ok(component.render(120).join(' ').includes('next-model'));
  await commands.get('footer')!.handler('native', f.ctx as ExtensionCommandContext);
  assert.equal(component, undefined);
  assert.equal(f.unsubscribed(), 1);
  await commands.get('footer')!.handler('clean', f.ctx as ExtensionCommandContext);
  assert.ok(component);
  f.ctx.ui.setFooter(() => ({ render: () => ['another footer'], invalidate() {} }));
  const callsAfterHandoff = footerCalls;
  await events.get('session_shutdown')!({}, f.ctx);
  assert.equal(footerCalls, callsAfterHandoff);
  assert.deepEqual(currentFooter()?.render(120), ['another footer']);
  assert.equal(f.unsubscribed(), 2);
  await commands.get('footer')!.handler('clean', f.ctx as ExtensionCommandContext);
  await events.get('session_shutdown')!({}, f.ctx);
  assert.equal(component, undefined);
  assert.equal(f.unsubscribed(), 3);
  await events.get('session_start')!({}, { ...f.ctx, mode: 'print' } as ExtensionContext);
  assert.equal(component, undefined);
});
