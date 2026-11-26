import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  SessionEntry,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { wrapTextWithAnsi } from '@earendil-works/pi-tui';

import { compact } from './live-throughput-status.ts';

const clean = (text: string) => stripVTControlCharacters(text).replace(/\p{Cc}/gu, ' ');

export function footerTotals(entries: readonly SessionEntry[]) {
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    cacheHit: undefined as number | undefined,
  };
  for (const entry of entries) {
    const message = entry.type === 'message' ? entry.message : undefined;
    const usage =
      entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary'
        ? entry.usage
        : message?.role === 'assistant' || message?.role === 'toolResult'
          ? message.usage
          : undefined;
    if (!usage) continue;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost.total;
    if (message?.role === 'assistant') {
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      totals.cacheHit = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
    }
  }
  return totals;
}

export function footerCwd(cwd: string, home = os.homedir()): string {
  const relative = path.relative(home, cwd);
  return relative === ''
    ? '~'
    : relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      ? '~' + path.sep + relative
      : cwd;
}

export function renderSessionFooter(
  ctx: ExtensionContext,
  data: ReadonlyFooterDataProvider,
  theme: Pick<Theme, 'fg' | 'bold'>,
  thinking: string,
  width: number,
): string[] {
  if (width < 1) return [];
  // ponytail: scan session entries per render; cache on append events if large sessions make this slow.
  const totals = footerTotals(ctx.sessionManager.getEntries());
  const value = (text: string) => theme.fg('accent', text);
  const label = (text: string) => theme.fg('muted', text);
  const row = (name: string, parts: string[]) =>
    wrapTextWithAnsi(label(name.padEnd(7)) + '  ' + parts.join('   '), width);
  const model = ctx.model;
  const identity = model ? clean(model.provider + '/' + model.id) : 'no model';
  const modelParts = [theme.bold(value(identity))];
  if (model?.reasoning) modelParts.push(label(clean(thinking) + ' reasoning'));
  const tokenParts = [value(compact(totals.input)) + label(' in'), value(compact(totals.output)) + label(' out')];
  if (totals.cacheRead) tokenParts.push(value(compact(totals.cacheRead)) + label(' cache read'));
  if (totals.cacheWrite) tokenParts.push(value(compact(totals.cacheWrite)) + label(' cache write'));
  if ((totals.cacheRead || totals.cacheWrite) && totals.cacheHit !== undefined)
    tokenParts.push(label('last hit ') + theme.fg('success', totals.cacheHit.toFixed(1) + '%'));
  const provider = model ? ctx.modelRegistry.getProvider(model.provider) : undefined;
  const subscription =
    !!model &&
    (model.provider === 'kimi-coding' ||
      (ctx.modelRegistry.isUsingOAuth(model) && provider?.auth.oauth?.isSubscription === true));
  if (totals.cost || subscription)
    tokenParts.push(theme.fg('success', '$' + totals.cost.toFixed(3)) + (subscription ? label(' subscription') : ''));
  const context = ctx.getContextUsage();
  const window = context?.contextWindow ?? model?.contextWindow;
  const percent = context?.percent;
  const contextText = percent === null || percent === undefined ? 'pending' : percent.toFixed(1) + '%';
  const color =
    percent === null || percent === undefined ? 'muted' : percent > 90 ? 'error' : percent > 70 ? 'warning' : 'accent';
  const contextParts = [
    theme.fg(color, contextText) + (window ? label(' of ') + value(compact(window)) : ''),
    label('cwd ' + clean(footerCwd(ctx.sessionManager.getCwd()))),
  ];
  const branch = data.getGitBranch();
  const name = ctx.sessionManager.getSessionName();
  if (branch) contextParts.push(label('branch ' + clean(branch)));
  if (name) contextParts.push(label('session ' + clean(name)));
  const lines = [...row('model', modelParts), ...row('tokens', tokenParts), ...row('context', contextParts)];
  const statuses = [...data.getExtensionStatuses()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) =>
      text.replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('\t', ' ').replace(/ +/g, ' ').trim(),
    )
    .filter(Boolean);
  if (statuses.length) lines.push(...wrapTextWithAnsi(statuses.join(' '), width));
  return lines;
}

export default function registerSessionFooter(pi: ExtensionAPI): void {
  let enabled = false;
  let installed = false;
  let current: ExtensionContext | undefined;
  let repaint: (() => void) | undefined;
  function install(ctx: ExtensionContext) {
    current = ctx;
    if (ctx.mode !== 'tui' || !enabled) return;
    ctx.ui.setFooter((tui, theme, data) => {
      installed = true;
      repaint = () => tui.requestRender();
      const unsubscribe = data.onBranchChange(repaint);
      return {
        invalidate() {},
        render: (width) => renderSessionFooter(current ?? ctx, data, theme, pi.getThinkingLevel(), width),
        dispose() {
          unsubscribe();
          installed = false;
          repaint = undefined;
        },
      };
    });
  }
  pi.on('session_start', (_event, ctx) => install(ctx));
  pi.on('model_select', (_event, ctx) => {
    current = ctx;
    repaint?.();
  });
  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.mode === 'tui' && installed) ctx.ui.setFooter(undefined);
    current = undefined;
  });
  pi.registerCommand('footer', {
    description: "Use the clean session footer or restore Pi's native footer",
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (mode !== '' && mode !== 'clean' && mode !== 'native') {
        ctx.ui.notify('Usage: /footer [clean|native]', 'warning');
        return;
      }
      enabled = mode !== 'native';
      if (enabled) install(ctx);
      else if (ctx.mode === 'tui') ctx.ui.setFooter(undefined);
    },
  });
}
