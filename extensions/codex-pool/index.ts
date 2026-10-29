import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { createCodexPool } from "./provider.ts";
import { AccountStore, PoolError, accountDisplayName } from "./store.ts";

function emit(ctx: ExtensionCommandContext, text: string, error = false): void {
  if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info");
  else (error ? console.error : console.log)(text);
}

function interaction(ctx: ExtensionCommandContext): ProviderAuthInteraction {
  const controller = new AbortController();
  const parentSignal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  return {
    signal: parentSignal,
    notify: (event) => {
      if (event.type === "auth_url") ctx.ui.notify(`${event.instructions ?? "Open to sign in:"}\n${event.url}`, "info");
      else if (event.type === "device_code") ctx.ui.notify(`Open ${event.verificationUri} and enter ${event.userCode}`, "info");
      else ctx.ui.notify(event.message, "info");
    },
    prompt: async (prompt) => {
      const signals = [prompt.signal, ctx.signal, controller.signal].filter(Boolean) as AbortSignal[];
      const opts = { signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] };
      const labels = prompt.type === "select" ? prompt.options.map((option) => option.label) : [];
      const value = prompt.type === "select"
        ? await ctx.ui.select(prompt.message, labels, opts)
        : await ctx.ui.input(prompt.message, prompt.placeholder, opts);
      if (value === undefined) {
        if (ctx.signal?.aborted) {
          controller.abort();
          throw new PoolError("Codex login cancelled.");
        }
        if (prompt.signal?.aborted) {
          // Per-prompt cancellation by SDK (e.g. browser callback succeeded while manual
          // code input was open). Keep parent login active; don't throw user-cancel error.
          return new Promise<string>(() => {});
        }
        controller.abort();
        throw new PoolError("Codex login cancelled.");
      }
      return prompt.type === "select" ? prompt.options[labels.indexOf(value)].id : value;
    },
  };
}

export default function codexPoolExtension(pi: ExtensionAPI): void {
  const store = new AccountStore(join(getAgentDir(), "codex-accounts.json"));
  let selectedId: string | undefined;
  const publishSelected = () => {
    if (selectedId) pi.events.emit("codex-pool:account-selected", { id: selectedId });
  };
  const pool = createCodexPool(store, undefined, (id) => {
    selectedId = id;
    publishSelected();
  });
  let unsubscribe = pi.events.on("codex-pool:request-account", publishSelected);
  pi.on("session_start", () => {
    selectedId = undefined;
    unsubscribe();
    unsubscribe = pi.events.on("codex-pool:request-account", publishSelected);
  });
  pi.on("session_shutdown", () => unsubscribe());
  (pi.registerProvider as (provider: unknown) => void)(pool.provider);
  pi.registerCommand("codex-pool.accounts", {
    description: "Codex pool: list | add | switch <id> | remove <id>",
    handler: async (args, ctx) => {
      try {
        const [action = "list", id, ...extra] = args.trim().split(/\s+/).filter(Boolean);
        if (extra.length || ((action === "list" || action === "add") && id)) {
          throw new PoolError("Usage: /codex-pool.accounts list|add|switch <id>|remove <id>");
        }
        if (action === "add") {
          if (!ctx.hasUI) throw new PoolError("Use /login codex-pool in an interactive Pi session to add accounts.");
          const added = await pool.add(interaction(ctx));
          emit(ctx, `Codex account linked: ${added.slice(0, 12)}. Select codex-pool in /model to use it.`);
        } else if (action === "switch" || action === "remove") {
          if (!id) throw new PoolError("Supply an account ID from /codex-pool.accounts list.");
          const changed = await store.manage(action, id, ctx.signal);
          pool.clearSticky();
          emit(ctx, `Codex account ${action === "switch" ? "preferred" : "removed"}: ${changed.slice(0, 12)}.`);
        } else if (action === "list") {
          const data = await store.read(ctx.signal);
          const lines = data.accounts.map((account, index) => {
            const status = account.needsLogin ? "login required" : (account.cooldownUntil ?? 0) > Date.now()
              ? `cooldown until ${new Date(account.cooldownUntil!).toISOString()}` : "ready";
            return `${account.id === data.preferred ? "*" : " "} ${account.id.slice(0, 12)}  ${accountDisplayName(account.credential, `Account ${index + 1}`)}  ${status}`;
          });
          emit(ctx, lines.length ? `${lines.join("\n")}\n* preferred; session choice stays sticky until unavailable or switched.` :
            "No Codex accounts. Use /login codex-pool or /codex-pool.accounts add.");
        } else throw new PoolError("Usage: /codex-pool.accounts list|add|switch <id>|remove <id>");
      } catch (error) {
        emit(ctx, error instanceof PoolError ? error.message : "Codex account operation failed.", true);
      }
    },
  });
}
