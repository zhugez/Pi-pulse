// /home/dev/pi-pulse/extensions/ponytail/index.ts
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

// @ts-expect-error untyped js module from bundled runtime dependency
import ponytailExtension from '../../node_modules/@dietrichgebert/ponytail/pi-extension/index.js';
import { resolveCrapper, runCrapper } from '../crap/index.ts';

/** Rows of the CRAP table handed to the audit; the tail is noise for a prompt. */
export const SNAPSHOT_ROWS = 5;
export const SNAPSHOT_TIMEOUT_MS = 120_000;

/**
 * An over-engineering audit that guesses which functions are too complex is
 * just opinion. crapper measures it, so the audit starts from numbers.
 * Returns undefined when crapper is missing or scores nothing, leaving the
 * command exactly as it was.
 */
export async function buildGateSnapshot(cwd: string | undefined, args: string): Promise<string | undefined> {
  if (!cwd) return undefined;
  const binary = resolveCrapper(cwd);
  if (!binary) return undefined;

  const scope = args.trim().split(/\s+/).filter(Boolean);
  const result = await runCrapper({
    binary,
    args: ['--no-coverage', ...scope],
    cwd,
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
  });
  if (result.status !== 'ok' || result.rows.length === 0) return undefined;

  const lines = result.rows
    .slice(0, SNAPSHOT_ROWS)
    .map((row) => `  CC=${row.complexity} ${row.name} (${row.namespace})`);
  if (result.rows.length > SNAPSHOT_ROWS) lines.push(`  … ${result.rows.length - SNAPSHOT_ROWS} more`);

  return [
    '## Gate snapshot (crapper, complexity only — not a path)',
    `${result.rows.length} functions, worst first. The CRAP gate is 10; a function at CC >= 10 fails it at any coverage.`,
    ...lines,
  ].join('\n');
}

export function sendPonytailSkill(
  pi: Pick<ExtensionAPI, 'sendUserMessage'>,
  skillName: string,
  args: string,
  ctx?: ExtensionCommandContext,
): void {
  const normalized = String(args || '').trim();
  const message = normalized ? `${skillName} ${normalized}` : skillName;

  if (ctx?.isIdle?.() === false) {
    pi.sendUserMessage(message, { deliverAs: 'followUp', expandPromptTemplates: true });
    ctx?.ui?.notify?.(`${skillName} queued as follow-up.`, 'info');
    return;
  }

  pi.sendUserMessage(message, { expandPromptTemplates: true });
}

export default function registerPonytail(pi: ExtensionAPI): void {
  ponytailExtension(pi);

  pi.registerCommand('pnt-opt', {
    description: 'Run /skill:ponytail-audit (whole-repo over-engineering audit) with a crapper complexity snapshot',
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const snapshot = await buildGateSnapshot(ctx.cwd, args);
      const scoped = snapshot ? `${args}\n\n${snapshot}` : args;
      sendPonytailSkill(pi, '/skill:ponytail-audit', scoped, ctx);
    },
  });
}
