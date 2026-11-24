import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execExom, resolveVaultRoot } from "../extensions/exomind/index.js";
import registerExoMind from "../extensions/exomind/index.js";

test("exomind: resolveVaultRoot resolves Yasna-Memory or environment path", () => {
  const root = resolveVaultRoot();
  assert.ok(root);
  assert.match(root, /Yasna-Memory/);
});

test('exomind: execExom runs exom from PATH and reports a missing binary', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-exomind-'));
  const originalPath = process.env.PATH;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.PATH = dir;

  const missing = await execExom(['--version']);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /ENOENT/);
  writeFileSync(
    join(dir, 'exom'),
    '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = --version ] || exit 64\nprintf "exom fixture\\n"\n',
    { mode: 0o755 },
  );
  assert.deepEqual(await execExom(['--version']), { exitCode: 0, stdout: 'exom fixture\n', stderr: '' });
});

test("exomind: registers tools and commands with Pi ExtensionAPI", () => {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any>();

  const fakePi: any = {
    registerTool: (def: any) => tools.set(def.name, def),
    registerCommand: (name: string, def: any) => commands.set(name, def),
    on: (name: string, handler: any) => events.set(name, handler),
  };

  registerExoMind(fakePi);

  assert.ok(tools.has("exom_recall"));
  assert.ok(tools.has("exom_capture"));
  assert.ok(commands.has("remember"));
  assert.ok(commands.has("recall"));
  assert.ok(events.has("session_start"));
  assert.ok(events.has("before_agent_start"));
});
