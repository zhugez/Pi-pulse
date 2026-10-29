import type { Message } from "@earendil-works/pi-ai/compat";

export const FOLLOW_UP_TTL_MS = 5 * 60 * 1000;
const FOLLOW_UP_MAX_DEPTH = 3;
export const FOLLOW_UP_MAX_TOOL_CALLS = 3;

export interface AdvisorFollowUpPayload {
  depth: number;
  messages: Message[];
  model: string;
  privacyKey: string;
  redacted: boolean;
  systemPrompt: string;
}

export interface AdvisorFollowUpLookup {
  payload?: AdvisorFollowUpPayload;
  reason?: string;
}

interface StoredFollowUpPayload extends AdvisorFollowUpPayload {
  expiresAt: number;
  toolCallsSince: number;
}

const copy = <Value>(value: Value): Value => structuredClone(value);

export class AdvisorFollowUpCache {
  readonly #entries = new Map<string, StoredFollowUpPayload>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  clear() {
    this.#entries.clear();
  }

  advanceToolCall() {
    const now = this.#now();

    for (const [adviceId, entry] of this.#entries) {
      if (
        now >= entry.expiresAt ||
        entry.toolCallsSince + 1 >= FOLLOW_UP_MAX_TOOL_CALLS
      ) {
        this.#entries.delete(adviceId);
        continue;
      }

      entry.toolCallsSince += 1;
    }
  }

  capture(
    adviceId: string,
    payload: AdvisorFollowUpPayload,
    replacesAdviceId?: string
  ) {
    if (replacesAdviceId) {
      this.#entries.delete(replacesAdviceId);
    }

    this.#entries.set(adviceId, {
      ...copy(payload),
      expiresAt: this.#now() + FOLLOW_UP_TTL_MS,
      toolCallsSince: 0,
    });
  }

  get(adviceId: string): AdvisorFollowUpLookup {
    const entry = this.#entries.get(adviceId);

    if (!entry) {
      return { reason: "the adviceId is unknown or no longer cached" };
    }

    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(adviceId);

      return { reason: "the cached payload has expired" };
    }

    if (entry.depth >= FOLLOW_UP_MAX_DEPTH) {
      return {
        reason: `the follow-up chain is limited to ${FOLLOW_UP_MAX_DEPTH} follow-ups`,
      };
    }

    return { payload: copy(entry) };
  }
}
