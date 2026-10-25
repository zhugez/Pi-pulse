import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { ensureFreshAccount, loginWorkBuddy } from "./auth.ts";
import { STATIC_CATALOG, fetchCatalog, loadCachedCatalog, saveCatalog, type WbCatalog } from "./catalog.ts";
import { dailyCheckin, fetchCredit } from "./credit.ts";
import { acceptTasks, buddy, claimTask, claimTrial, listTasks, lottery, redeemStreak, streak, travel } from "./growth.ts";
import { createWorkBuddyProvider } from "./provider.ts";
import { AccountStore, accountLabel, importPanelAuths, type WbAccount } from "./store.ts";
import { createWorkBuddyFetch } from "./transport.ts";

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
      const value = prompt.type === "select"
        ? await ctx.ui.select(prompt.message, prompt.options.map((option) => option.label), { signal: parentSignal })
        : await ctx.ui.input(prompt.message, prompt.placeholder, { signal: parentSignal });
      if (value === undefined) controller.abort();
      return value;
    },
  } as ProviderAuthInteraction;
}

function statusOf(account: WbAccount): string {
  if (account.needsLogin) return "login required";
  if (account.cooldownUntil && account.cooldownUntil > Date.now()) return `cooldown until ${new Date(account.cooldownUntil).toISOString()}`;
  return "ready";
}

export default function workbuddyPoolExtension(pi: ExtensionAPI): void {
  const store = new AccountStore(join(getAgentDir(), "workbuddy-accounts.json"));
  let catalog: WbCatalog = loadCachedCatalog() ?? STATIC_CATALOG;

  const transport = createWorkBuddyFetch({ store, catalog: () => catalog });
  const provider = createWorkBuddyProvider({
    store,
    fetchImpl: transport.fetch,
    catalog: () => catalog,
    setCatalog: (next) => { catalog = next; },
  });
  try {
    (pi.registerProvider as (value: unknown) => void)(provider);
  } catch (error) {
    console.error("[wb] registerProvider failed:", error instanceof Error ? error.message : error);
    throw error;
  }

  // Warm the catalog at startup so /model lists models before the first request.
  void (async () => {
    const data = await store.read();
    const account = data.accounts.find((candidate) => !candidate.needsLogin) ?? data.accounts[0];
    if (!account) return;
    try {
      const fresh = await ensureFreshAccount(store, account);
      catalog = await fetchCatalog(fresh);
      saveCatalog(catalog);
    } catch {
      /* offline or upstream hiccup: the provider still serves the built-in list */
    }
  })();

  pi.registerCommand("workbuddy", {
    description: "WorkBuddy: login | accounts | import | credit | checkin | models | tasks | trial | streak | lottery | travel | buddy",
    handler: async (args, ctx) => {
      const [action = "accounts", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        switch (action) {
          case "login": {
            if (!ctx.hasUI) throw new Error("Run /workbuddy login in an interactive session.");
            const account = await loginWorkBuddy(interaction(ctx));
            await store.upsert(account);
            emit(ctx, `WorkBuddy account linked: ${accountLabel(account)}. Pick a workbuddy model in /model.`);
            return;
          }
          case "import": {
            const dir = rest[0] ?? join(homedir(), "workbuddy2api-panel", "auths");
            const imported = await importPanelAuths(dir);
            if (imported.length === 0) {
              emit(ctx, `No WorkBuddy accounts found in ${dir}.`, true);
              return;
            }
            for (const account of imported) await store.upsert(account);
            emit(ctx, `Imported ${imported.length} account(s) from ${dir}: ${imported.map(accountLabel).join(", ")}`);
            return;
          }
          case "credit": {
            const data = await store.read();
            if (data.accounts.length === 0) throw new Error("No WorkBuddy accounts. Use /workbuddy login.");
            const lines: string[] = [];
            for (const account of data.accounts) {
              try {
                const fresh = await ensureFreshAccount(store, account, ctx.signal);
                const credit = await fetchCredit(fresh, ctx.signal);
                await store.update((state) => {
                  const current = state.accounts.find((a) => a.uid === account.uid);
                  if (current) current.credit = credit.remaining;
                });
                lines.push(`${accountLabel(account)}: ${credit.remaining} credit left (used ${credit.used}, ${credit.packages} package(s)${credit.cycleEnd ? `, cycle ends ${credit.cycleEnd}` : ""})`);
              } catch (error) {
                lines.push(`${accountLabel(account)}: ${error instanceof Error ? error.message : "credit lookup failed"}`);
              }
            }
            emit(ctx, lines.join("\n"));
            return;
          }
          case "checkin": {
            const data = await store.read();
            const lines: string[] = [];
            for (const account of data.accounts) {
              const fresh = await ensureFreshAccount(store, account, ctx.signal);
              lines.push(`${accountLabel(account)}: ${await dailyCheckin(fresh, ctx.signal)}`);
            }
            emit(ctx, lines.join("\n") || "No WorkBuddy accounts.");
            return;
          }
          case "tasks": {
            const data = await store.read();
            const account = data.accounts.find((candidate) => !candidate.needsLogin) ?? data.accounts[0];
            if (!account) throw new Error("No WorkBuddy accounts. Use /workbuddy login.");
            const taskAction = rest[0] ?? "list";
            if (taskAction === "list") emit(ctx, JSON.stringify(await listTasks(account, ctx.signal), null, 2));
            else if (taskAction === "accept") emit(ctx, JSON.stringify(await acceptTasks(account, rest.slice(1), ctx.signal), null, 2));
            else if (taskAction === "claim" && rest[1]) emit(ctx, JSON.stringify(await claimTask(account, rest[1], ctx.signal), null, 2));
            else throw new Error("Usage: /workbuddy tasks list|accept <codes...>|claim <code>");
            return;
          }
          case "trial": {
            const data = await store.read();
            for (const account of data.accounts) emit(ctx, `${accountLabel(account)}: ${JSON.stringify(await claimTrial(account, ctx.signal))}`);
            return;
          }
          case "streak": {
            const data = await store.read();
            for (const account of data.accounts) emit(ctx, `${accountLabel(account)}: ${JSON.stringify(await streak(account, ctx.signal))}`);
            return;
          }
          case "lottery": {
            const data = await store.read();
            for (const account of data.accounts) emit(ctx, `${accountLabel(account)}: ${JSON.stringify(await lottery(account, ctx.signal))}`);
            return;
          }
          case "travel": {
            const data = await store.read();
            const account = data.accounts.find((candidate) => !candidate.needsLogin) ?? data.accounts[0];
            if (!account) throw new Error("No WorkBuddy accounts. Use /workbuddy login.");
            const mode = (rest[0] ?? "status") as "status" | "depart" | "claim";
            const value = rest[1] ? Number(rest[1]) : undefined;
            emit(ctx, JSON.stringify(await travel(account, mode, value, ctx.signal), null, 2));
            return;
          }
          case "buddy": {
            const data = await store.read();
            const account = data.accounts.find((candidate) => !candidate.needsLogin) ?? data.accounts[0];
            if (!account) throw new Error("No WorkBuddy accounts. Use /workbuddy login.");
            const mode = (rest[0] ?? "info") as "info" | "first" | "agreement";
            emit(ctx, JSON.stringify(await buddy(account, mode, ctx.signal), null, 2));
            return;
          }
          case "models": {
            const data = await store.read();
            const account = data.accounts.find((candidate) => !candidate.needsLogin) ?? data.accounts[0];
            if (!account) throw new Error("No WorkBuddy accounts. Use /workbuddy login.");
            const fresh = await ensureFreshAccount(store, account, ctx.signal);
            catalog = await fetchCatalog(fresh, ctx.signal);
            saveCatalog(catalog);
            emit(ctx, `${catalog.models.length} models:\n${catalog.models.map((model) => `${model.id}  ${model.name}${model.reasoning ? "  (reasoning)" : ""}`).join("\n")}`);
            return;
          }
          case "accounts": {
            if (rest[0] === "remove") {
              const uid = rest[1];
              if (!uid) throw new Error("Usage: /workbuddy accounts remove <uid>");
              const removed = await store.remove(uid);
              emit(ctx, removed ? `Removed ${uid.slice(0, 8)}.` : `No account ${uid.slice(0, 8)}.`, !removed);
              return;
            }
            const data = await store.read();
            if (data.accounts.length === 0) {
              emit(ctx, "No WorkBuddy accounts. Use /workbuddy login or /workbuddy import.");
              return;
            }
            emit(ctx, data.accounts.map((account) =>
              `${account.uid.slice(0, 8)}  ${accountLabel(account)}  ${account.realm}  ${statusOf(account)}${account.credit !== undefined ? `  credit ${account.credit}` : ""}`,
            ).join("\n"));
            return;
          }
          default:
            throw new Error("Usage: /workbuddy login | accounts | import | credit | checkin | models | tasks | trial | streak | lottery | travel | buddy");
        }
      } catch (error) {
        emit(ctx, error instanceof Error ? error.message : "WorkBuddy command failed", true);
      }
    },
  });

}
