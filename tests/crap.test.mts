import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CRAP_THRESHOLD,
  formatCrapSummary,
  parseCrapRows,
  resolveCrapper,
  runCrapper,
} from '../extensions/crap/index.ts';

// Real output captured from `crapper --no-coverage extensions/loop-guard extensions/comment-checker`.
const REAL_REPORT = `CRAP Report
===========
Languages: typescript

Function                              Namespace                               CC    Cov%     CRAP
-------------------------------------------------------------------------------------------------
parseApplyPatchRequests               extensions.comment-checker.core         23   N/A       N/A
spawnProcess                          extensions.comment-checker.cli          13   N/A       N/A
createCommentCheckerToolResultHandler extensions.comment-checker.index        10   N/A       N/A
runCommentChecker                     extensions.comment-checker.cli           9   N/A       N/A
check                                 extensions.loop-guard.index.LoopGuard    8   N/A       N/A
`;

const SCORED_REPORT = `CRAP Report
===========

Function                              Namespace       CC    Cov%     CRAP
-------------------------------------------------------------------------
hot                                   demo.core       14   20.0     24.6
warm                                  demo.core        6   80.0      6.5
cold                                  demo.core        2   0.0       6.0
`;

test('crap: parses the real report table', () => {
  const rows = parseCrapRows(REAL_REPORT);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], {
    name: 'parseApplyPatchRequests',
    namespace: 'extensions.comment-checker.core',
    complexity: 23,
    coverage: null,
    crap: null,
  });
  assert.equal(rows[4]?.name, 'check');
  assert.equal(rows[4]?.namespace, 'extensions.loop-guard.index.LoopGuard');
});

test('crap: parses scored rows and ignores the header and separator', () => {
  const rows = parseCrapRows(SCORED_REPORT);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { name: 'hot', namespace: 'demo.core', complexity: 14, coverage: 20, crap: 24.6 });
});

test('crap: summary counts the functions over the gate and ranks by CRAP', () => {
  const summary = formatCrapSummary(parseCrapRows(SCORED_REPORT));
  assert.match(summary, /3 functions, 1 over CRAP 10/);
  assert.match(summary, /CRAP=24\.6 \(CC=14, cov=20%\)\s+hot/);
  assert.ok(summary.indexOf('hot') < summary.indexOf('warm'), 'worst first');
});

test('crap: without coverage it says so instead of pretending CRAP is 0', () => {
  const summary = formatCrapSummary(parseCrapRows(REAL_REPORT));
  assert.match(summary, /coverage not measured/);
  assert.match(summary, /CC=23\s+parseApplyPatchRequests/);
  assert.doesNotMatch(summary, /CRAP=/);
});

test('crap: an empty tree reports it rather than showing an empty table', () => {
  assert.match(formatCrapSummary([], { report: 'CRAP Report\n' }), /no scorable functions/);
});

test('crap: the top-row limit is applied and the remainder is counted', () => {
  const summary = formatCrapSummary(parseCrapRows(REAL_REPORT), { top: 2 });
  assert.match(summary, /… 3 more/);
  assert.equal(summary.split('\n').length, 4); // header + 2 rows + remainder
});

test('crap: discovery prefers PI_CRAPPER, then PATH, then the project launcher', () => {
  const cwd = '/work';
  const runnable = (path: string) =>
    path === '/override/crapper' || path === '/bin/crapper' || path === '/work/crapper';

  assert.equal(resolveCrapper(cwd, { PI_CRAPPER: '/override/crapper', PATH: '/bin' }, runnable), '/override/crapper');
  assert.equal(resolveCrapper(cwd, { PATH: '/bin:/usr/bin' }, runnable), '/bin/crapper');
  assert.equal(resolveCrapper(cwd, { PATH: '/usr/bin' }, runnable), '/work/crapper');
  assert.equal(
    resolveCrapper(cwd, { PATH: '/usr/bin' }, () => false),
    undefined,
  );
});

test('crap: a fake launcher is executed with the args and its table is parsed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pulse-crap-'));
  try {
    const binary = join(dir, 'crapper');
    await writeFile(
      binary,
      `#!/usr/bin/env bash\nif [ "$1" != "--no-coverage" ]; then echo "bad args" >&2; exit 1; fi\ncat <<'REPORT'\n${SCORED_REPORT}REPORT\n`,
      'utf8',
    );
    await chmod(binary, 0o755);

    const result = await runCrapper({ binary, args: ['--no-coverage'], cwd: dir });
    assert.equal(result.status, 'ok');
    assert.equal(result.rows.length, 3);
    assert.equal(result.rows[0]?.crap, 24.6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('crap: exit 2 (threshold exceeded) is a result, not a failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pulse-crap-'));
  try {
    const binary = join(dir, 'crapper');
    await writeFile(binary, `#!/usr/bin/env bash\ncat <<'REPORT'\n${SCORED_REPORT}REPORT\nexit 2\n`, 'utf8');
    await chmod(binary, 0o755);

    const result = await runCrapper({ binary, args: [], cwd: dir });
    assert.equal(result.status, 'ok');
    assert.equal(result.rows.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('crap: a missing binary is reported, not thrown', async () => {
  const result = await runCrapper({ binary: '/nonexistent/crapper', args: [], cwd: '/tmp' });
  assert.equal(result.status, 'missing');
  assert.equal(result.rows.length, 0);
});

test('crap: the ub-mode gate is CRAP 10', () => {
  assert.equal(CRAP_THRESHOLD, 10);
});
