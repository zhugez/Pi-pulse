import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Alpakyros Pool loads without local SDK dependencies", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-pulse-alpakyros-"));
  try {
    const extension = join(agentDir, "index.ts");
    cpSync(new URL("../extensions/alpakyros-pool/index.ts", import.meta.url), extension);
    const result = spawnSync(process.env.PI_BIN ?? "pi", [
      "--mode", "rpc", "--no-session", "-ne", "-e", extension,
    ], {
      cwd: agentDir,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      input: '{"id":"startup","type":"get_commands"}\n',
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Failed to load extension|Cannot find module/);
    assert.match(result.stdout, /"success":true/);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Codex Pool loads through the installed Pi CLI without local SDK dependencies", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-pulse-startup-"));
  try {
    const extensionDir = join(agentDir, "codex-pool");
    cpSync(new URL("../extensions/codex-pool/", import.meta.url), extensionDir, { recursive: true });
    const extension = join(extensionDir, "index.ts");
    const result = spawnSync(process.env.PI_BIN ?? "pi", [
      "--mode", "rpc", "--no-session", "-ne", "-e", extension,
    ], {
      cwd: agentDir,
      env: { ...process.env, PI_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      input: '{"id":"startup","type":"get_commands"}\n',
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Failed to load extension|Cannot find module/);
    assert.match(result.stdout, /codex-pool\.accounts/);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
