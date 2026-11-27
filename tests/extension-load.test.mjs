import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from 'node:url';
import test from "node:test";

test('Traceveil command and skill load through Pi without an installed Traceveil binary', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-pulse-traceveil-load-'));
  try {
    const extension = join(agentDir, 'traceveil.ts');
    cpSync(new URL('../extensions/traceveil/index.ts', import.meta.url), extension);
    const skill = fileURLToPath(new URL('../skills/traceveil/SKILL.md', import.meta.url));
    const result = spawnSync(
      process.env.PI_BIN ?? 'pi',
      ['--offline', '--mode', 'rpc', '--no-session', '-ne', '-e', extension, '--no-skills', '--skill', skill],
      {
        cwd: agentDir,
        env: {
          ...process.env,
          HOME: agentDir,
          USERPROFILE: agentDir,
          PI_CODING_AGENT_DIR: agentDir,
          PI_AGENT_DIR: agentDir,
          PI_OFFLINE: '1',
          TRACEVEIL_BIN: join(agentDir, 'missing-traceveil'),
        },
        input: '{"id":"startup","type":"get_commands"}\n',
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const response = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((item) => item.command === 'get_commands');
    assert.ok(response?.success, result.stderr);
    const names = response.data.commands.map((command) => command.name);
    assert.ok(names.includes('traceveil'));
    assert.ok(names.includes('skill:traceveil'));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test('Invar loads through Pi without local SDK dependencies or an installed Invar binary', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-pulse-invar-load-'));
  try {
    const extension = join(agentDir, 'invar.ts');
    cpSync(new URL('../extensions/invar/index.ts', import.meta.url), extension);
    const result = spawnSync(process.env.PI_BIN ?? 'pi', [
      '--offline', '--mode', 'rpc', '--no-session', '-ne', '-e', extension,
    ], {
      cwd: agentDir,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir, PI_OFFLINE: '1', INVAR_BIN: join(agentDir, 'missing-invar') },
      input: '{"id":"startup","type":"get_commands"}\n',
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Failed to load extension|Cannot find module/);
    assert.match(result.stdout, /"name":"invar"/);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test('Antigravity Pool respects native logout and migrates only on command', () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-pulse-antigravity-upgrade-'));
  try {
    const dir = join(home, 'pi-profile');
    mkdirSync(dir);
    const path = join(dir, 'auth.json');
    const legacy = { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 3600_000 };
    const fresh = { ...legacy, access: 'new-access' };
    const other = { type: 'api_key', key: 'unrelated-key' };
    const writeAuth = (auth, prefix = '') => writeFileSync(path, prefix + JSON.stringify(auth), { mode: 0o600 });
    const readAuth = () => JSON.parse(readFileSync(path, 'utf8'));
    const extension = fileURLToPath(new URL('../extensions/antigravity/index.ts', import.meta.url));
    const runPi = (args, input) => {
      const result = spawnSync(process.env.PI_BIN ?? 'pi', args, {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PI_CODING_AGENT_DIR: '~/pi-profile',
          PI_AGENT_DIR: dir,
          PI_OFFLINE: '1',
        },
        input,
        encoding: 'utf8',
        timeout: 20_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result;
    };

    const listModels = () => runPi(['--offline', '-ne', '-e', extension, '--list-models', 'antigravity-pool']);
    const migrate = () => {
      const result = runPi(
        ['--offline', '-ne', '-e', extension, '--mode', 'rpc', '--no-session'],
        '{"id":"migration","type":"prompt","message":"/antigravity.migrate"}\n',
      );
      return result.stdout + result.stderr;
    };

    writeAuth({ antigravity: legacy, 'antigravity-pool': fresh, other });
    runPi(['auth', 'logout', 'antigravity-pool']);
    assert.doesNotMatch(listModels().stdout, /^antigravity-pool\s/m);
    assert.deepEqual(readAuth(), { antigravity: legacy, other });

    writeAuth({ antigravity: legacy, 'antigravity-pool': fresh, other });
    const beforeCollision = readFileSync(path, 'utf8');
    assert.match(migrate(), /Both Antigravity credential entries exist/);
    assert.equal(readFileSync(path, 'utf8'), beforeCollision);

    const accountsPath = join(dir, 'antigravity-accounts.json');
    const linked = JSON.stringify({
      version: 1,
      activeAccountId: 'linked',
      accounts: { linked: { refresh: 'linked-refresh' } },
    });
    writeFileSync(accountsPath, linked, { mode: 0o600 });
    writeAuth({ antigravity: legacy, other }, '\uFEFF');
    assert.match(migrate(), /Moved the legacy OAuth login to antigravity-pool/);
    assert.deepEqual(readAuth(), { 'antigravity-pool': legacy, other });
    assert.equal(readFileSync(accountsPath, 'utf8'), linked);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.match(listModels().stdout, /^antigravity-pool\s/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

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
