import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface OutageNotifier {
  /** Notifies once per distinct category+message; records the key even headless. */
  notify: (ctx: ExtensionContext, category: string, message: string) => void;
  /** Test-only: re-arms the once-per-outage notification. */
  reset: () => void;
}

/** Creates an independently stateful once-per-outage notifier. */
export const createOutageNotifier = (
  format: (category: string, message: string) => string
): OutageNotifier => {
  let lastKey: string | undefined;

  return {
    notify: (ctx, category, message) => {
      const key = `${category}:${message}`;

      if (key === lastKey) {
        return;
      }

      lastKey = key;

      if (ctx.hasUI) {
        ctx.ui.notify(format(category, message), "warning");
      }
    },
    reset: () => {
      lastKey = undefined;
    },
  };
};
