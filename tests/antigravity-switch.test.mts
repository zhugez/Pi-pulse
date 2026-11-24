import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { lockSync } from "proper-lockfile";
import { Agent, MockAgent } from "undici";
import { activateAccount, listAccounts, migrateLegacyAntigravityAuth, removeAccount } from "../extensions/antigravity/auth/accounts.ts";
import registerAntigravity from "../extensions/antigravity/index.ts";

function profile(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ag-auth-review-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, authPath: join(dir, "auth.json"), linkedPath: join(dir, "antigravity-accounts.json") };
}

function credentials(name: string, expires = Date.now() + 3600_000) {
  return { type: "oauth", email: `${name}@example.test`, access: `${name}-access`, refresh: `${name}-refresh`, expires, projectId: "test-project" };
}

function seedSelection(t: TestContext, expires?: number) {
  const paths = profile(t);
  const a = credentials("a");
  const b = credentials("b", expires);
  const auth = { "antigravity-pool": a };
  const store = { version: 1, activeAccountId: "a", rotate: true, accounts: {
    a: { ...a, accountId: "a", addedAt: 1, lastUsedAt: 1 },
    b: { ...b, accountId: "b", addedAt: 2, lastUsedAt: 2 },
  } };
  writeFileSync(paths.authPath, JSON.stringify(auth));
  writeFileSync(paths.linkedPath, JSON.stringify(store));
  return { ...paths, auth, store, a, b };
}

test("Antigravity startup leaves migration lock to the explicit command", (t) => {
  const { authPath: path } = profile(t);
  const legacy = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 };
  const other = { type: "api_key", key: "other-key" };
  writeFileSync(path, JSON.stringify({ antigravity: legacy }), { mode: 0o600 });
  const unlock = lockSync(path, { stale: 30_000 });
  try {
    const olderThanDefaultStale = new Date(Date.now() - 12_000);
    utimesSync(`${path}.lock`, olderThanDefaultStale, olderThanDefaultStale);
    let registered = false;
    registerAntigravity({
      registerProvider() { registered = true; },
      registerCommand() {},
    } as unknown as ExtensionAPI);
    assert.equal(registered, true);
    assert.throws(migrateLegacyAntigravityAuth, { code: "ELOCKED" });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { antigravity: legacy });
    writeFileSync(path, "");
    assert.throws(migrateLegacyAntigravityAuth, { code: "ELOCKED" });
    writeFileSync(path, JSON.stringify({ antigravity: legacy, other }));
  } finally { unlock(); }
  assert.equal(migrateLegacyAntigravityAuth(), "migrated");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "antigravity-pool": legacy, other });
  assert.equal(migrateLegacyAntigravityAuth(), "absent");
  writeFileSync(path, "");
  assert.equal(migrateLegacyAntigravityAuth(), "absent");
  assert.equal(readFileSync(path, "utf8"), "");
  writeFileSync(path, "{");
  assert.throws(migrateLegacyAntigravityAuth, /unreadable Pi auth.json/);
  assert.equal(readFileSync(path, "utf8"), "{");
});

test("account switch refreshes the model registry using the newly active credential", async (t) => {
  const { authPath, linkedPath: accountsPath } = profile(t);
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

test("removing the nonactive canonical owner prevents reimport", async (t) => {
  const { authPath, linkedPath, a, b } = seedSelection(t);
  writeFileSync(authPath, JSON.stringify({ "antigravity-pool": b }));
  await removeAccount("b");
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), { "antigravity-pool": a });
  assert.deepEqual(listAccounts().map(({ accountId, active }) => ({ accountId, active })), [{ accountId: "a", active: true }]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(linkedPath, "utf8")).accounts), ["a"]);

  writeFileSync(authPath, "");
  await activateAccount("a");
  assert.equal(JSON.parse(readFileSync(authPath, "utf8"))["antigravity-pool"].access, "a-access");
  writeFileSync(authPath, "");
  await removeAccount("a");
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), {});
});

for (const scenario of ["logout during switch", "replacement changes during removal", "unrelated updates during switch", "unrelated updates during removal"] as const) {
  test(`Antigravity selection: ${scenario}`, async (t) => {
    const { authPath, linkedPath, auth, store } = seedSelection(t, 0);
    const mock = new MockAgent();
    mock.disableNetConnect();
    t.after(() => mock.close());
    const oauth = mock.get("https://oauth2.googleapis.com");
    const other = { type: "api_key", key: "other-provider-key" };
    let externalAuth: object = auth;
    let externalStore: object = store;
    oauth.intercept({ path: "/token", method: "POST" }).reply(() => {
      const unlock = lockSync(authPath, { stale: 30_000 });
      try {
        if (scenario === "logout during switch") {
          externalAuth = {};
          writeFileSync(authPath, JSON.stringify(externalAuth));
        } else if (scenario === "replacement changes during removal") {
          store.accounts.b.refresh = "newer-refresh";
          writeFileSync(linkedPath, JSON.stringify(store));
        } else {
          externalAuth = { ...auth, other };
          externalStore = { ...store, accounts: {
            ...store.accounts,
            b: { ...store.accounts.b, cooldownUntil: 12345 },
            c: { ...credentials("c"), accountId: "c", addedAt: 3, lastUsedAt: 0 },
          } };
          writeFileSync(authPath, JSON.stringify(externalAuth));
          writeFileSync(linkedPath, JSON.stringify(externalStore));
        }
      } finally { unlock(); }
      return { statusCode: 200, data: { access_token: "refreshed-access", expires_in: 3600 } };
    });
    t.mock.method(Agent.prototype, "dispatch", oauth.dispatch.bind(oauth));
    const operation = scenario.endsWith("switch") ? activateAccount("b") : removeAccount("a");
    if (!scenario.startsWith("unrelated")) {
      await assert.rejects(operation, /selection changed/);
      assert.equal(readFileSync(authPath, "utf8"), JSON.stringify(externalAuth));
      assert.equal(readFileSync(linkedPath, "utf8"), JSON.stringify(externalStore));
    } else {
      await operation;
      const updatedAuth = JSON.parse(readFileSync(authPath, "utf8"));
      const updatedStore = JSON.parse(readFileSync(linkedPath, "utf8"));
      assert.deepEqual(updatedAuth.other, other);
      assert.equal(updatedAuth["antigravity-pool"].access, "refreshed-access");
      assert.equal(updatedStore.activeAccountId, "b");
      assert.equal(updatedStore.accounts.b.cooldownUntil, 12345);
      assert.equal(updatedStore.accounts.c.refresh, "c-refresh");
    }
    mock.assertNoPendingInterceptors();
  });
}

test("Antigravity switch and removal publish neither file if second staging write fails", async (t) => {
  const { dir, authPath, linkedPath } = seedSelection(t);
  const auth = readFileSync(authPath, "utf8");
  const linked = readFileSync(linkedPath, "utf8");
  const write = fs.writeFileSync;
  let staged = 0;
  const injection = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
    if (basename(String(args[0])) === "state.json" && ++staged === 2) {
      throw Object.assign(new Error("No space while staging"), { code: "ENOSPC" });
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  try {
    for (const action of [() => activateAccount("b"), () => removeAccount("a")]) {
      staged = 0;
      await assert.rejects(action, { code: "ENOSPC" });
      assert.equal(readFileSync(authPath, "utf8"), auth);
      assert.equal(readFileSync(linkedPath, "utf8"), linked);
      assert.deepEqual(fs.readdirSync(dir).sort(), ["antigravity-accounts.json", "auth.json"]);
    }
  } finally {
    injection.mock.restore();
    syncBuiltinESMExports();
  }
});
