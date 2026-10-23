/**
 * Account rate-limit state, shaped for the host's status channel.
 *
 * The CLI emits a `rate_limit_event` per turn describing ONE window: the first
 * one whose warning threshold has been crossed, walking
 * `5h -> 7d -> 7d_oi -> overage`. So the reported window is the binding
 * constraint, not an arbitrary pick — and there is no way to see all four at
 * once from this stream. A front-end that wants "which limit will stop me, how
 * close am I, and when does it reset" has everything it needs; one that wants
 * a full dashboard does not, and should not pretend otherwise.
 *
 * Kept pure and separate from `index.ts` so the payload contract is testable
 * without a pi runtime.
 */

/** What the host receives under the `claude-rate-limit` status key. */
export interface RateLimitPayload {
  status: unknown;
  resetsAt: unknown;
  rateLimitType: unknown;
  overageStatus: unknown;
  isUsingOverage: boolean;
  /** Fraction of the window consumed: 1.01 means 101%, i.e. over. */
  utilization: number | null;
  /** Which warning step tripped, when one has. */
  surpassedThreshold: number | null;
  observedAt: number;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildRateLimitPayload(
  info: Record<string, unknown>,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): RateLimitPayload {
  return {
    status: info.status,
    resetsAt: info.resetsAt,
    rateLimitType: info.rateLimitType,
    overageStatus: info.overageStatus,
    isUsingOverage: info.isUsingOverage === true,
    // The CLI has always sent these two; dropping them left front-ends able to
    // say WHICH limit was in play and when it resets, but never how close it
    // was — so a user could not watch themselves approach a wall, only hit it.
    utilization: num(info.utilization),
    surpassedThreshold: num(info.surpassedThreshold),
    observedAt: nowSeconds,
  };
}

/**
 * Identity of a payload ignoring `observedAt`, for change detection.
 *
 * The event repeats every turn with a fresh timestamp; pushing that verbatim
 * would rewrite the host's status constantly and make anything rendering it
 * flicker. Comparing everything EXCEPT the timestamp is what makes the push
 * "on change" rather than "on turn".
 */
/** Human-readable footer text; pi's footer renders status strings verbatim. */
export function formatRateLimit(p: RateLimitPayload): string {
  const parts = [`claude ${String(p.rateLimitType ?? "5h")}: ${String(p.status ?? "?")}`];
  if (p.utilization !== null) parts.push(`${Math.round(p.utilization * 100)}%`);
  if (typeof p.resetsAt === "number") {
    const ms = p.resetsAt < 10_000_000_000 ? p.resetsAt * 1000 : p.resetsAt;
    const d = new Date(ms);
    parts.push(`reset ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
  }
  if (p.isUsingOverage) parts.push("overage");
  return parts.join(" · ");
}

export function rateLimitIdentity(payload: RateLimitPayload): string {
  const { observedAt: _observedAt, ...rest } = payload;
  return JSON.stringify(rest);
}
