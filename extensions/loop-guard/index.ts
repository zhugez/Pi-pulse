import { createHash } from 'node:crypto';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Identical-loop guard.
//
// A model that repeats the same call with byte-identical arguments is not
// making progress: the result cannot change. pi has no loop detection of its
// own, so this blocks the repeat and hands the model an actionable reason
// (the block reason is the reminder — no extra notice plumbing needed).
//
// Thresholds are borrowed from the evidence in code-yeongyu/senpi's
// loop-guard: a firm reminder at 3 identical calls, so the 4th is the first
// one worth refusing. After a block the threshold drops to 2 so a genuinely
// stuck agent escalates instead of grinding.
//
//   PI_LOOP_GUARD=0   disable

/** Consecutive byte-identical calls before the first block. */
export const IDENTICAL_RUN_THRESHOLD = 4;
/** Threshold once this signature has already been blocked at least once. */
export const ESCALATED_RUN_THRESHOLD = 2;

export interface LoopGuardVerdict {
  block: true;
  reason: string;
}

/** Stable serialization so key order in the model's JSON cannot hide a repeat. */
export function canonicalSignature(toolName: string, input: unknown): string {
  const body = canonical(input);
  return createHash('sha256').update(toolName).update('\0').update(body).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

export class LoopGuard {
  private lastSignature: string | undefined;
  private runLength = 0;
  private blocks = 0;

  reset(): void {
    this.lastSignature = undefined;
    this.runLength = 0;
    this.blocks = 0;
  }

  /**
   * Returns a verdict when the call should be refused, `undefined` to let it run.
   * `nested` marks calls another tool issued — those are never blocked, since the
   * calling tool is already under the model's control and cannot re-plan mid-script.
   */
  check(
    toolName: string,
    input: unknown,
    options: { nested?: boolean; enabled?: boolean } = {},
  ): LoopGuardVerdict | undefined {
    if (options.enabled === false) return undefined;

    const signature = canonicalSignature(toolName, input);
    if (signature === this.lastSignature) {
      this.runLength += 1;
    } else {
      this.lastSignature = signature;
      this.runLength = 1;
      this.blocks = 0;
    }

    const threshold = this.blocks > 0 ? ESCALATED_RUN_THRESHOLD : IDENTICAL_RUN_THRESHOLD;
    if (this.runLength < threshold) return undefined;
    if (options.nested) return undefined;

    this.blocks += 1;
    // Let the next attempt through so a blocked call cannot deadlock the run;
    // if it is identical again the lower threshold catches it quickly.
    this.runLength = 0;

    const attempt =
      this.blocks > 1 ? 'This exact call has been blocked before.' : 'The previous call had the same arguments.';
    return {
      block: true,
      reason: [
        `Blocked: \`${toolName}\` was called ${threshold === ESCALATED_RUN_THRESHOLD ? 'repeatedly' : `${threshold} times`} in a row with identical arguments.`,
        attempt,
        'Repeating it cannot produce a different result. Read the last result again, change the arguments, or use a different tool before retrying.',
      ].join(' '),
    };
  }
}

function guardDisabled(): boolean {
  const raw = process.env.PI_LOOP_GUARD;
  return raw === '0' || raw === 'false';
}

/**
 * Nested-call marker (calls another tool issued). Only newer pi releases set it,
 * so it is read structurally: an absent field means a normal model-issued call.
 */
function isNestedCall(event: unknown): boolean {
  if (typeof event !== 'object' || event === null || !('parentToolCallId' in event)) return false;
  return (event as { parentToolCallId?: unknown }).parentToolCallId !== undefined;
}

export default function registerLoopGuard(pi: ExtensionAPI): void {
  const guard = new LoopGuard();

  pi.on('session_start', () => {
    guard.reset();
  });

  pi.on('tool_call', (event) => {
    const verdict = guard.check(event.toolName, event.input, {
      nested: isNestedCall(event),
      enabled: !guardDisabled(),
    });
    if (!verdict) return undefined;
    return { block: true, reason: verdict.reason };
  });
}
