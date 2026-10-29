import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

// CRAP gate (unclebob/ub-mode): CRAP = CC² × (1 − coverage)³ + CC.
// A command, not a tool: a coverage run takes minutes and the first invocation
// bootstraps a Python venv, so it must never sit in the per-edit path.
//
//   /crap                     # complexity only, fast (--no-coverage)
//   /crap --changed           # only git additions and edits, with coverage
//   /crap src/foo             # a path or path fragment
//
//   PI_CRAPPER=/path/to/crapper   override binary discovery

/** ub-mode's gate: every function under CRAP 10. */
export const CRAP_THRESHOLD = 10;
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_TOP_ROWS = 15;

export type CrapRow = {
  name: string;
  namespace: string;
  complexity: number;
  coverage: number | null;
  crap: number | null;
};

export type CrapRunResult = {
  status: 'ok' | 'missing' | 'error';
  rows: CrapRow[];
  report: string;
  message?: string;
};

// Function and namespace are identifiers (never spaces), so whitespace separates
// the columns. A name as long as the column width is followed by a single space,
// which is why this is \s+ and not \s{2,}. "N/A" means coverage was not measured.
const ROW_PATTERN = /^(\S+)\s+(\S+)\s+(\d+)\s+(N\/A|[\d.]+)\s+(N\/A|[\d.]+)$/;

function toNumber(value: string): number | null {
  return value === 'N/A' ? null : Number(value);
}

export function parseCrapRows(stdout: string): CrapRow[] {
  const rows: CrapRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = ROW_PATTERN.exec(line.trimEnd());
    if (!match) continue;
    const [, name, namespace, complexity, coverage, crap] = match;
    if (!name || !namespace || !complexity || !coverage || !crap) continue;
    rows.push({
      name,
      namespace,
      complexity: Number(complexity),
      coverage: toNumber(coverage),
      crap: toNumber(crap),
    });
  }
  return rows;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discovery order: `PI_CRAPPER`, then `crapper` on PATH, then the repo's own
 * `./crapper` launcher in the working directory (crapper self-bootstraps a venv).
 */
export function resolveCrapper(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  isRunnable: (path: string) => boolean = (path) => existsSync(path) && isExecutable(path),
): string | undefined {
  const override = env.PI_CRAPPER;
  if (override && isRunnable(override)) return override;

  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'crapper');
    if (isRunnable(candidate)) return candidate;
  }

  const local = join(cwd, 'crapper');
  if (isRunnable(local)) return local;
  return undefined;
}

export function runCrapper(options: {
  binary: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<CrapRunResult> {
  const { binary, args, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const report = `${stdout ?? ''}${stderr ?? ''}`.trim();
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            resolve({ status: 'missing', rows: [], report, message: `crapper not found at ${binary}` });
            return;
          }
          // crapper exits 2 when --threshold is exceeded: that is a result, not a failure.
          if ((error as { code?: number }).code === 2) {
            resolve({ status: 'ok', rows: parseCrapRows(stdout ?? ''), report });
            return;
          }
          resolve({ status: 'error', rows: parseCrapRows(stdout ?? ''), report, message: error.message });
          return;
        }
        resolve({ status: 'ok', rows: parseCrapRows(stdout ?? ''), report });
      },
    );
  });
}

function formatCrapHeader(rows: CrapRow[], threshold: number): string {
  const scored = rows.filter((row) => row.crap !== null);
  if (scored.length === 0) {
    return `${rows.length} functions, coverage not measured — ranking by cyclomatic complexity (CRAP needs coverage)`;
  }
  const over = scored.filter((row) => (row.crap ?? 0) > threshold);
  return `${rows.length} functions, ${over.length} over CRAP ${threshold}`;
}

function formatCrapRow(row: CrapRow): string {
  const score =
    row.crap === null
      ? `CC=${row.complexity}`
      : `CRAP=${row.crap.toFixed(1)} (CC=${row.complexity}, cov=${row.coverage?.toFixed(0) ?? '?'}%)`;
  return `  ${score.padEnd(34)} ${row.name}  ${row.namespace}`;
}

export function formatCrapSummary(
  rows: CrapRow[],
  options: { threshold?: number; top?: number; report?: string } = {},
): string {
  if (rows.length === 0) {
    const tail = (options.report ?? '').trim();
    return tail
      ? `crapper produced no scorable functions.\n${tail}`
      : 'crapper produced no scorable functions for this tree.';
  }

  const top = options.top ?? DEFAULT_TOP_ROWS;
  const lines = rows.slice(0, top).map(formatCrapRow);
  if (rows.length > top) lines.push(`  … ${rows.length - top} more`);
  return [formatCrapHeader(rows, options.threshold ?? CRAP_THRESHOLD), ...lines].join('\n');
}

export default function registerCrap(pi: ExtensionAPI): void {
  pi.registerCommand('crap', {
    description: 'CRAP score gate (unclebob/ub-mode): /crap [--changed|--no-coverage|<path>]',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const say = (message: string, level: 'info' | 'warning' | 'error' = 'info') => {
        if (ctx.hasUI) ctx.ui.notify(message, level);
        else console.log(message);
      };

      const binary = resolveCrapper(ctx.cwd);
      if (!binary) {
        say(
          'crapper not found. Set PI_CRAPPER, install it (pip install unclebob/crapper), or place its ./crapper launcher in this project.',
          'warning',
        );
        return;
      }

      const passthrough = args.trim().length > 0 ? args.trim().split(/\s+/) : ['--no-coverage'];
      const result = await runCrapper({ binary, args: passthrough, cwd: ctx.cwd });

      if (result.status === 'missing') {
        say(result.message ?? 'crapper not found.', 'warning');
        return;
      }
      if (result.status === 'error') {
        say(`crapper failed: ${result.message}\n${result.report}`.trim(), 'error');
        return;
      }
      say(formatCrapSummary(result.rows, { report: result.report }), 'info');
    },
  });
}
