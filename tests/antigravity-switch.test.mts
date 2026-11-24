import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { lockSync } from "proper-lockfile";
import { migrateLegacyAntigravityAuth } from "../extensions/antigravity/auth/accounts.ts";
import registerAntigravity from "../extensions/antigravity/index.ts";

test("migration shares Pi's auth lock and preserves intervening changes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ag-auth-migration-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "auth.json");
  const legacy = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 };
  const other = { type: "api_key", key: "other-key" };
  writeFileSync(path, JSON.stringify({ antigravity: legacy }), { mode: 0o600 });
  const unlock = lockSync(path);
  try {
    assert.throws(migrateLegacyAntigravityAuth, { code: "ELOCKED" });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { antigravity: legacy });
    writeFileSync(path, JSON.stringify({ antigravity: legacy, other }));
  } finally { unlock(); }
  migrateLegacyAntigravityAuth();
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "antigravity-pool": legacy, other });
});

test("account switch refreshes the model registry using the newly active credential", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ag-switch-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "auth.json"), "{}");
  writeFileSync(join(dir, "antigravity-accounts.json"), JSON.stringify({
    version: 1,
    accounts: { ultra: { accountId: "ultra", email: "ultra@example.com", access: "ultra-token", refresh: "test-refresh", expires: Date.now() + 3600_000, addedAt: 1, lastUsedAt: 1 } },
  }));
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  registerAntigravity({
    registerProvider(id: string) { assert.equal(id, "antigravity-pool"); },
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, command); },
  } as unknown as ExtensionAPI);
  let refreshed = false;
  const notices: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (text: string) => notices.push(text) },
    modelRegistry: {
      refresh: async (options: { force?: boolean; providers?: string[] }) => {
        assert.equal(options.force, true);
        assert.deepEqual(options.providers, ["antigravity-pool"]);
        const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
        assert.equal(auth["antigravity-pool"].access, "ultra-token");
        assert.equal(auth.antigravity, undefined);
        refreshed = true;
        return { errors: new Map() };
      },
    },
  } as unknown as ExtensionCommandContext;
  await commands.get("antigravity.accounts")!.handler("switch ultra", ctx);
  assert.equal(refreshed, true, "switch must refresh models, not only credentials");
  assert.match(notices.at(-1)!, /Active Antigravity account/);
});
