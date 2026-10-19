import assert from "node:assert/strict";
import test from "node:test";
import { execExom, resolveVaultRoot } from "../extensions/exomind/index.js";
import registerExoMind from "../extensions/exomind/index.js";

test("exomind: resolveVaultRoot resolves Yasna-Memory or environment path", () => {
  const root = resolveVaultRoot();
  assert.ok(root);
  assert.match(root, /Yasna-Memory/);
});

test("exomind: execExom runs binary and gets version/help", async () => {
  const result = await execExom(["--version"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /exom/);
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
