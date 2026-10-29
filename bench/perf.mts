// Micro-benchmarks for the hot paths pi-pulse puts in front of every tool call.
//
//   node --experimental-strip-types bench/perf.mts           # print results
//   node --experimental-strip-types bench/perf.mts --write   # refresh baseline
//
// Reports median and p95. Median alone hides the tail that users feel, so the
// gate in scripts/bench.sh compares both against bench/baseline.json with a 5%
// noise tolerance.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCommentCheckRequests } from '../extensions/comment-checker/core.ts';
import { checkFileDiagnostics } from '../extensions/lens/diagnostics.ts';
import { canonicalSignature } from '../extensions/loop-guard/index.ts';

const BASELINE = new URL('./baseline.json', import.meta.url);
const RUNS = 200;
const NOISE_TOLERANCE = 0.05;

type Sample = { name: string; medianMs: number; p95Ms: number; runs: number };

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

async function measure(name: string, runs: number, fn: () => unknown | Promise<unknown>): Promise<Sample> {
  const samples: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    name,
    medianMs: Number(percentile(samples, 0.5).toFixed(4)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(4)),
    runs,
  };
}

const TOOL_CALL_INPUT = { command: 'npm test -- --run', timeout: 120_000, cwd: '/workspace/pi-pulse' };
const TOOL_RESULT = {
  toolName: 'edit',
  input: { path: 'src/example.ts', old_string: 'const value = 1;', new_string: 'const value = 2;' },
  content: [{ type: 'text' as const, text: 'edited src/example.ts' }],
  isError: false,
};
const TS_SOURCE = `import path from "node:path";
export interface Account { id: string; email: string }
export class Pool {
  constructor(private readonly accounts: Account[]) {}
  pick(id: string): Account | undefined {
    return this.accounts.find((account) => account.id === id);
  }
}
export const label = (account: Account): string => \`\${account.id}:\${account.email}\`;
`;

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-pulse-bench-'));
  const tsFile = join(workspace, 'sample.ts');
  await writeFile(tsFile, TS_SOURCE, 'utf8');

  try {
    let coldRuns = 0;
    const samples: Sample[] = [
      await measure('loop-guard/canonicalSignature', RUNS, () => canonicalSignature('bash', TOOL_CALL_INPUT)),
      await measure('comment-checker/extractCommentCheckRequests', RUNS, () =>
        extractCommentCheckRequests(TOOL_RESULT),
      ),
      // Spawns tsc. The content changes every run so the diagnostics LRU cache
      // never hides the real cost.
      await measure('lens/checkFileDiagnostics (cold, spawns tsc)', 9, () => {
        coldRuns += 1;
        const source = `${TS_SOURCE}\nexport const run${coldRuns} = ${coldRuns};\n`;
        return checkFileDiagnostics(tsFile, source);
      }),
    ];

    const report = {
      generatedAt: new Date().toISOString(),
      noiseTolerance: NOISE_TOLERANCE,
      absoluteFloorMs: 1,
      samples,
    };
    if (process.argv.includes('--write')) {
      await writeFile(BASELINE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`wrote ${BASELINE.pathname}`);
      return;
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();
