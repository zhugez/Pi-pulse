import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi 0.99 asserts ctx liveness on UI access; post-session reads must no-op.
const isStaleContext = (error: unknown): error is Error =>
  error instanceof Error && /stale/iu.test(error.message);

export const uiAvailable = (ctx: ExtensionContext): boolean => {
  try {
    return ctx.hasUI;
  } catch (error) {
    if (isStaleContext(error)) {
      return false;
    }

    throw error;
  }
};

export const uiAction = (
  ctx: ExtensionContext,
  action: (ui: ExtensionContext["ui"]) => void
): void => {
  try {
    if (ctx.hasUI) {
      action(ctx.ui);
    }
  } catch (error) {
    if (!isStaleContext(error)) {
      throw error;
    }
  }
};
