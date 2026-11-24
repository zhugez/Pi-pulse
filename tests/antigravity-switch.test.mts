import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  const unlock = lockSync(path, { stale: 30_000 });
  try {
    const olderThanDefaultStale = new Date(Date.now() - 12_000);
    utimesSync(`${path}.lock`, olderThanDefaultStale, olderThanDefaultStale);
    assert.throws(migrateLegacyAntigravityAuth, { code: "ELOCKED" });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { antigravity: legacy });
    writeFileSync(path, "");
    assert.throws(migrateLegacyAntigravityAuth, { code: "ELOCKED" });
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
  const authPath = join(dir, "auth.json");
  const accountsPath = join(dir, "antigravity-accounts.json");
  const base = { type: "oauth", email: "base@example.com", access: "base-token", refresh: "base-refresh", expires: Date.now() + 3600_000 };
  const authBefore = `\uFEFF${JSON.stringify({ "antigravity-pool": base })}`;
  writeFileSync(authPath, authBefore);
  const accountsBefore = JSON.stringify({
    version: 1,
    rotate: true,
    activeAccountId: "base",
    accounts: {
      base: { ...base, accountId: "base", refresh: "previous-refresh", addedAt: 1, lastUsedAt: 1 },
      ultra: { accountId: "ultra", email: "ultra@example.com", access: "ultra-token", refresh: "test-refresh", expires: Date.now() + 3600_000, addedAt: 2, lastUsedAt: 2 },
    },
  });
  writeFileSync(accountsPath, accountsBefore);
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
        const auth = JSON.parse(readFileSync(authPath, "utf8"));
        assert.equal(auth["antigravity-pool"].access, "ultra-token");
        assert.equal(auth.antigravity, undefined);
        refreshed = true;
        return { errors: new Map() };
      },
    },
  } as unknown as ExtensionCommandContext;
  const run = (args: string) => commands.get("antigravity.accounts")!.handler(args, ctx);
  const unlock = lockSync(authPath, { stale: 30_000 });
  try {
    for (const action of ["switch ultra", "remove base"]) {
      await run(action);
      assert.match(notices.at(-1)!, /already being held/);
      assert.equal(refreshed, false);
      assert.equal(readFileSync(authPath, "utf8"), authBefore);
      assert.equal(readFileSync(accountsPath, "utf8"), accountsBefore);
    }
  } finally { unlock(); }

  await run("switch ultra");
  assert.equal(refreshed, true, "switch must refresh models, not only credentials");
  assert.match(notices.at(-1)!, /Active Antigravity account/);
  const selected = JSON.parse(readFileSync(accountsPath, "utf8"));
  assert.equal(selected.accounts.base.refresh, "base-refresh");
  assert.equal(selected.activeAccountId, "ultra");
  assert.equal(selected.rotate, false);

  await run("remove ultra");
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), { "antigravity-pool": base });
  await run("remove base");
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), {});
  assert.deepEqual(JSON.parse(readFileSync(accountsPath, "utf8")).accounts, {});
});
