import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import { resolveExecutable, runProcess } from '../gates/process.ts';

// Mutation gate (unclebob/ub-mode): a mutant survives when the tests still pass,
// so survivors are exactly the behavior nothing checks.
//
//   /mutator                 # --changed: git additions and edits
//   /mutator --scan src/core # list mutation sites, run no tests
//   /mutator src/core        # one file or directory
//   /mutator --test-command "pnpm test" src/core
//
//   PI_MUTATOR=/path/to/mutator        override binary discovery
//   PI_MUTATOR_TIMEOUT_MS=600000       default 15 minutes
//
// Slower than /crap by an order of magnitude: each mutant re-runs the tests.
// mutator keeps a snapshot in .metrics/mutate/, so every run after the first is
// differential — it only re-runs survivors and functions whose text changed.

export const DEFAULT_TIMEOUT_MS = 900_000;
export const DEFAULT_SURVIVOR_LINES = 10;

export type MutatorSummary = {
  killed: number;
  survived: number;
  uncovered: number;
  sites: number;
  score: number | null;
  survivors: string[];
  baselineFailed: boolean;
};

export type MutatorRunResult = {
  status: 'ok' | 'missing' | 'error';
  summary: MutatorSummary;
  report: string;
  message?: string;
};

const SURVIVOR_PATTERN = /^SURVIVED\s+(.+)$/;
const TOTAL_PATTERN = /^Total\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)%$/;
const BASELINE_PATTERN = /^Baseline failed for (.+?):\s*(.*)$/;

export function parseMutatorReport(stdout: string): MutatorSummary {
  const survivors: string[] = [];
  let totals: Omit<MutatorSummary, 'survivors' | 'baselineFailed'> | undefined;
  let baselineFailed = false;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    const survivor = SURVIVOR_PATTERN.exec(trimmed);
    if (survivor?.[1]) {
      survivors.push(survivor[1].trim());
      continue;
    }
    const total = TOTAL_PATTERN.exec(trimmed);
    if (total) {
      totals = {
        killed: Number(total[1]),
        survived: Number(total[2]),
        uncovered: Number(total[3]),
        sites: Number(total[4]),
        score: Number(total[5]),
      };
      continue;
    }
    if (BASELINE_PATTERN.test(trimmed)) baselineFailed = true;
  }

  const base = totals ?? { killed: 0, survived: survivors.length, uncovered: 0, sites: survivors.length, score: null };
  return { ...base, survivors, baselineFailed };
}

/** mutator exits 3 when a mutant survives: a result, not a failure. */
export async function runMutator(options: {
  binary: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<MutatorRunResult> {
  const { binary, args, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const result = await runProcess({ binary, args, cwd, timeoutMs, okExitCodes: [0, 2, 3] });
  return {
    status: result.status,
    summary: parseMutatorReport(result.stdout),
    report: `${result.stdout}${result.stderr}`.trim(),
    message: result.message,
  };
}

function formatSurvivorLine(survivor: string): string {
  return `  ${survivor}`;
}

export function formatMutatorSummary(summary: MutatorSummary, options: { top?: number; report?: string } = {}): string {
  if (summary.baselineFailed) {
    // The failing command is on the "Baseline failed" line, its output on the next.
    const lines = (options.report ?? '').split(/\r?\n/);
    const index = lines.findIndex((line) => line.includes('Baseline failed'));
    const detail = index >= 0 ? lines.slice(index, index + 2).filter((line) => line.trim().length > 0) : [];
    return [
      'Baseline tests failed, so no mutants were run. Fix the suite first.',
      ...detail.map((line) => `  ${line}`),
    ].join('\n');
  }
  if (summary.sites === 0) {
    return 'No mutation sites found for this selection.';
  }

  const score = summary.score === null ? 'unknown' : `${summary.score.toFixed(1)}%`;
  const header = `${summary.sites} sites: ${summary.killed} killed, ${summary.survived} survived, ${summary.uncovered} uncovered (score ${score})`;
  if (summary.survivors.length === 0) return `${header}\nEvery executed mutant was killed.`;

  const top = options.top ?? DEFAULT_SURVIVOR_LINES;
  const lines = summary.survivors.slice(0, top).map(formatSurvivorLine);
  if (summary.survivors.length > top) lines.push(`  … ${summary.survivors.length - top} more`);
  lines.push('Survivors are behavior no test checks: add a test that kills each one, or delete the code.');
  return [header, ...lines].join('\n');
}

export default function registerMutator(pi: ExtensionAPI): void {
  pi.registerCommand('mutator', {
    description: 'Mutation gate (unclebob/ub-mode): /mutator [--scan|--changed|<path>] — slow, runs tests per mutant',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const say = (message: string, level: 'info' | 'warning' | 'error' = 'info') => {
        if (ctx.hasUI) ctx.ui.notify(message, level);
        else console.log(message);
      };

      const binary = resolveExecutable('mutator', ctx.cwd);
      if (!binary) {
        say(
          'mutator not found. Set PI_MUTATOR, or clone unclebob/mutator next to a crapper checkout (it reads namespaces from ../crapper) and use its ./mutator launcher.',
          'warning',
        );
        return;
      }

      const timeoutMs = Number(process.env.PI_MUTATOR_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
      const passthrough = args.trim().length > 0 ? args.trim().split(/\s+/) : ['--changed'];
      const result = await runMutator({ binary, args: passthrough, cwd: ctx.cwd, timeoutMs });

      if (result.status === 'missing') {
        say(result.message ?? 'mutator not found.', 'warning');
        return;
      }
      if (result.status === 'error') {
        say(`mutator failed: ${result.message}\n${result.report}`.trim(), 'error');
        return;
      }
      say(formatMutatorSummary(result.summary, { report: result.report }), 'info');
    },
  });
}
