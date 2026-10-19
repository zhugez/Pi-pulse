/** Configurable context has one loader; execution remains Claude-native. */

export const PI_CONTEXT_MARKER = '<pi_context_policy version="1">';
export class ContextPolicyError extends Error {}
export const MIN_CONTEXT_CLI_VERSION = "2.1.263";

/** Do not assume older CLIs honor memory/skill isolation environment controls. */
export function assertContextCliVersion(output: string): void {
  const match = /(\d+)\.(\d+)\.(\d+)(?=\s|$)/.exec(output.trim());
  const parts = match?.slice(1).map(Number);
  const floor = MIN_CONTEXT_CLI_VERSION.split(".").map(Number);
  const difference = parts
    ?.map((part, i) => part - floor[i])
    .find((n) => n !== 0);
  if (!parts || (difference !== undefined && difference < 0)) {
    throw new ContextPolicyError(
      `Pi context requires Claude Code ${MIN_CONTEXT_CLI_VERSION}+ (the tested isolation controls). Update Claude Code before using this policy.`,
    );
  }
}

export function usesPiContext(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.PI_CLAUDE_CLI_CONTEXT ?? "pi").trim().toLowerCase();
  if (value === "pi") return true;
  if (!value || value === "legacy") return false;
  throw new ContextPolicyError(
    "PI_CLAUDE_CLI_CONTEXT must be 'pi' or 'legacy'.",
  );
}

/** A policy change cannot safely reuse the CLI's hidden history/pinned prompt. */
export function assertContextPolicy(
  storedPrompt: string | undefined,
  piContext: boolean,
): void {
  if ((storedPrompt?.startsWith(PI_CONTEXT_MARKER) ?? false) !== piContext) {
    throw new ContextPolicyError(
      "Claude context policy changed (or its saved prompt is missing). Start a fresh pi session; the existing Claude transcript was not migrated.",
    );
  }
}
