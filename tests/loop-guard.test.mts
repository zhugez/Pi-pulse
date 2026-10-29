import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ESCALATED_RUN_THRESHOLD,
  IDENTICAL_RUN_THRESHOLD,
  LoopGuard,
  canonicalSignature,
} from '../extensions/loop-guard/index.ts';

test('loop-guard: identical arguments are hashed independent of key order', () => {
  assert.equal(
    canonicalSignature('bash', { command: 'ls', timeout: 5 }),
    canonicalSignature('bash', { timeout: 5, command: 'ls' }),
  );
  assert.notEqual(canonicalSignature('bash', { command: 'ls' }), canonicalSignature('read', { command: 'ls' }));
  assert.notEqual(canonicalSignature('bash', { command: 'ls' }), canonicalSignature('bash', { command: 'ls -la' }));
});

test('loop-guard: blocks on the fourth identical call, not before', () => {
  const guard = new LoopGuard();
  const input = { command: 'npm test' };

  for (let attempt = 1; attempt < IDENTICAL_RUN_THRESHOLD; attempt += 1) {
    assert.equal(guard.check('bash', input), undefined, `attempt ${attempt} must run`);
  }

  const verdict = guard.check('bash', input);
  assert.equal(verdict?.block, true);
  assert.match(verdict!.reason, /identical arguments/);
});

test('loop-guard: a changed argument resets the run', () => {
  const guard = new LoopGuard();
  for (let attempt = 0; attempt < IDENTICAL_RUN_THRESHOLD - 1; attempt += 1) {
    assert.equal(guard.check('bash', { command: 'npm test' }), undefined);
  }
  assert.equal(guard.check('bash', { command: 'npm test -- --run' }), undefined);
  assert.equal(guard.check('bash', { command: 'npm test' }), undefined);
});

test('loop-guard: lets one call through after a block, then escalates faster', () => {
  const guard = new LoopGuard();
  const input = { command: 'npm test' };
  for (let attempt = 0; attempt < IDENTICAL_RUN_THRESHOLD - 1; attempt += 1) guard.check('bash', input);
  assert.equal(guard.check('bash', input)?.block, true);

  // A blocked call must not deadlock the run.
  assert.equal(guard.check('bash', input), undefined);
  assert.equal(ESCALATED_RUN_THRESHOLD, 2);
  const second = guard.check('bash', input);
  assert.equal(second?.block, true);
  assert.match(second!.reason, /blocked before/);
});

test('loop-guard: nested calls are never blocked', () => {
  const guard = new LoopGuard();
  const input = { command: 'npm test' };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal(guard.check('bash', input, { nested: true }), undefined);
  }
});

test('loop-guard: reset clears the run (new session, new branch)', () => {
  const guard = new LoopGuard();
  const input = { command: 'npm test' };
  for (let attempt = 0; attempt < IDENTICAL_RUN_THRESHOLD - 1; attempt += 1) guard.check('bash', input);
  guard.reset();
  assert.equal(guard.check('bash', input), undefined);
});

test('loop-guard: PI_LOOP_GUARD=0 disables the guard', () => {
  const guard = new LoopGuard();
  const input = { command: 'npm test' };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal(guard.check('bash', input, { enabled: false }), undefined);
  }
});
