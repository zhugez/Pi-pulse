import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import nomad from "../extensions/nomad/index.ts";

const SELF = fileURLToPath(import.meta.url);
const BUN = [join(homedir(), ".bun/bin/bun"), "/usr/local/bin/bun", "/usr/bin/bun"].find((path) => existsSync(path));
const HARNESS_TIMEOUT_MS = 30_000;

// The extension spawns `bun run <dir>/gateway.ts`. tsc compiles the imported index.ts but leaves
// gateway.ts behind (it is referenced as a path, not imported), so the compiled tree needs a copy.
function stageGateway(): void {
  const compiled = join(dirname(dirname(SELF)), "extensions", "nomad");
  if (existsSync(join(compiled, "gateway.ts"))) return;
  const source = join(process.cwd(), "extensions", "nomad");
  cpSync(join(source, "gateway.ts"), join(compiled, "gateway.ts"));
  cpSync(join(source, "fixtures"), join(compiled, "fixtures"), { recursive: true });
}

if (process.env.NOMAD_HARNESS === "1") {
  // Harness: load the extension against a fake Pi, report the port, then let the module end.
  // A gateway that is not unref'd keeps this process alive; one that is not killed leaks.
  stageGateway();
  const providers: { getModels: () => { baseUrl?: string }[] }[] = [];
  await nomad({
    registerProvider: (value: unknown) => providers.push(value as (typeof providers)[number]),
    registerCommand: () => {},
  } as never);
  const baseUrl = providers[0]?.getModels()[0]?.baseUrl ?? "";
  const port = baseUrl ? new URL(baseUrl).port : "";
  let health = "fail";
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (response.ok && ((await response.json()) as { ok?: boolean }).ok) health = "ok";
  } catch {}
  console.log(`PORT=${port} HEALTH=${health}`);
}

test("nomad gateway neither holds Pi's event loop nor outlives it", {
  skip: !BUN ? "bun not found; the gateway cannot start" : process.env.NOMAD_HARNESS === "1" ? "running as the harness" : false,
}, async () => {
  const child = spawn(process.execPath, [SELF], {
    env: { ...process.env, NOMAD_HARNESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));

  const started = Date.now();
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), HARNESS_TIMEOUT_MS);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  const elapsed = Date.now() - started;

  assert.equal(code, 0, `harness must exit on its own, not on the timeout (rc=${code}, ${elapsed}ms)\n${stderr}`);
  assert.ok(elapsed < HARNESS_TIMEOUT_MS, `harness took ${elapsed}ms`);
  const [port, health] = /PORT=(\d+) HEALTH=(\w+)/.exec(stdout)?.slice(1) ?? [];
  assert.equal(health, "ok", `gateway must answer /health before the exit test means anything\n${stdout}${stderr}`);
  assert.ok(port, `harness must report the gateway port\n${stdout}${stderr}`);

  await new Promise((resolve) => setTimeout(resolve, 300));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), "gateway must be killed when Pi exits");
});
