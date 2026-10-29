import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_TIMEOUT_MS,
  formatMutatorSummary,
  parseMutatorReport,
  runMutator,
} from '../extensions/mutator/index.ts';

// Real output captured from `mutator --no-coverage --test-command "python3 test_calc.py" calc.py`.
const SURVIVORS_REPORT = `Wrote /tmp/mut-demo/.metrics/mutate/calc.edn
SURVIVED  calc.py:2 > -> >=
SURVIVED  calc.py:2 0 -> 1
SURVIVED  calc.py:3 1 -> 0
SURVIVED  calc.py:4 0 -> 1
Function Namespace  Killed  Survived  Uncovered  Sites   Score
--------------------------------------------------------------
sign     calc            0         4          0      4   0.0%
--------------------------------------------------------------
Total                    0         4          0      4    0.0%
`;

const CLEAN_REPORT = `Function Namespace  Killed  Survived  Uncovered  Sites   Score
--------------------------------------------------------------
sign     calc            4         0          0      4  100.0%
--------------------------------------------------------------
Total                    4         0          0      4  100.0%
`;

const BASELINE_FAILED = `Baseline failed for src/crapper/metrics.py: /tmp/crapper/.venv/bin/python -m pytest
/tmp/crapper/.venv/bin/python: No module named pytest
`;

test('mutator: parses survivors and the total row', () => {
  const summary = parseMutatorReport(SURVIVORS_REPORT);
  assert.equal(summary.sites, 4);
  assert.equal(summary.killed, 0);
  assert.equal(summary.survived, 4);
  assert.equal(summary.score, 0);
  assert.deepEqual(summary.survivors, [
    'calc.py:2 > -> >=',
    'calc.py:2 0 -> 1',
    'calc.py:3 1 -> 0',
    'calc.py:4 0 -> 1',
  ]);
  assert.equal(summary.baselineFailed, false);
});

test('mutator: a clean run reports a 100% score and no survivors', () => {
  const summary = parseMutatorReport(CLEAN_REPORT);
  assert.equal(summary.killed, 4);
  assert.equal(summary.score, 100);
  const text = formatMutatorSummary(summary);
  assert.match(text, /4 sites: 4 killed, 0 survived/);
  assert.match(text, /Every executed mutant was killed/);
});

test('mutator: a failed baseline is reported instead of a zero score', () => {
  const summary = parseMutatorReport(BASELINE_FAILED);
  assert.equal(summary.baselineFailed, true);
  const text = formatMutatorSummary(summary, { report: BASELINE_FAILED });
  assert.match(text, /Baseline tests failed/);
  assert.match(text, /No module named pytest/);
});

test('mutator: survivors are listed worst-first with a cap', () => {
  const text = formatMutatorSummary(parseMutatorReport(SURVIVORS_REPORT), { top: 2 });
  assert.match(text, /4 sites: 0 killed, 4 survived, 0 uncovered \(score 0\.0%\)/);
  assert.match(text, /calc\.py:2 > -> >=/);
  assert.match(text, /… 2 more/);
  assert.match(text, /Survivors are behavior no test checks/);
});

test('mutator: an empty selection says so', () => {
  assert.match(formatMutatorSummary(parseMutatorReport('')), /No mutation sites found/);
});

test('mutator: exit 3 (a mutant survived) is a result, not a failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pulse-mutator-'));
  try {
    const binary = join(dir, 'mutator');
    await writeFile(binary, `#!/usr/bin/env bash\ncat <<'REPORT'\n${SURVIVORS_REPORT}REPORT\nexit 3\n`, 'utf8');
    await chmod(binary, 0o755);

    const result = await runMutator({ binary, args: ['--changed'], cwd: dir });
    assert.equal(result.status, 'ok');
    assert.equal(result.summary.survived, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mutator: exit 2 (failed baseline) is a result, not a failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pulse-mutator-'));
  try {
    const binary = join(dir, 'mutator');
    await writeFile(binary, `#!/usr/bin/env bash\ncat <<'REPORT'\n${BASELINE_FAILED}REPORT\nexit 2\n`, 'utf8');
    await chmod(binary, 0o755);

    const result = await runMutator({ binary, args: [], cwd: dir });
    assert.equal(result.status, 'ok');
    assert.equal(result.summary.baselineFailed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mutator: any other exit code is a real failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pulse-mutator-'));
  try {
    const binary = join(dir, 'mutator');
    await writeFile(binary, "#!/usr/bin/env bash\necho 'traceback' >&2\nexit 1\n", 'utf8');
    await chmod(binary, 0o755);

    const result = await runMutator({ binary, args: [], cwd: dir });
    assert.equal(result.status, 'error');
    assert.match(result.report, /traceback/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mutator: a missing binary is reported, not thrown', async () => {
  const result = await runMutator({ binary: '/nonexistent/mutator', args: [], cwd: '/tmp' });
  assert.equal(result.status, 'missing');
  assert.equal(result.summary.sites, 0);
});

test('mutator: the default timeout is generous enough for a mutation run', () => {
  assert.ok(DEFAULT_TIMEOUT_MS >= 600_000);
});
