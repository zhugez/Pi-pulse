import { antigravityEnv } from "./util.js";

/**
 * Antigravity HTTP transport.
 *
 * Node 22+ global `fetch` manages HTTP keep-alive connection pooling natively and
 * respects the process-wide global dispatcher and proxy configuration.
 */
const PREWARM_TIMEOUT_MS = 5_000;

let prewarmStarted = false;

/** Native fetch wrapper preserving provider-global proxy and connection pool behavior. */
export async function antigravityFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(input, init);
}

/**
 * Open the TLS connection on the first Antigravity request so that turn does not
 * pay the handshake. Not called at extension load: an unauthenticated HEAD to the
 * endpoint can stall Node's event loop until connect timeout and freeze Pi startup.
 * Best-effort: failures are ignored. Subsequent calls are no-ops.
 */
export function prewarmConnection(url: string): void {
  if (antigravityEnv("NO_PREWARM") === "1") return;
  if (prewarmStarted) return;
  prewarmStarted = true;
  void (async () => {
    try {
      const res = await antigravityFetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
      });
      // Release the socket back to the pool even though HEAD carries no body.
      await res.arrayBuffer();
    } catch {
      // Warm-up only; the real request will establish the connection instead.
    }
  })();
}
