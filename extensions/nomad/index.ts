import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const BUN_CANDIDATES = [join(homedir(), ".bun/bin/bun"), "/usr/local/bin/bun", "/usr/bin/bun"];
const DB = join(homedir(), ".local/share/opencode/opencode.db");
const GATEWAY = join(import.meta.dirname, "gateway.ts");

function findBun(): string | undefined {
  for (const path of BUN_CANDIDATES) if (existsSync(path)) return path;
  try {
    return execFileSync("command", ["-v", "bun"], { shell: "/bin/sh", encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function opencodeSession(): string {
  if (!existsSync(DB)) return "";
  try {
    const out = execFileSync(
      "python3",
      ["-c", `import sqlite3;c=sqlite3.connect('${DB}');r=c.execute('SELECT id FROM session_v2 ORDER BY time_created DESC LIMIT 1').fetchone();print(r[0] if r else '')`],
      { encoding: "utf8", timeout: 5000 },
    );
    return out.trim();
  } catch {
    return "";
  }
}

async function waitHealthy(port: number, tries = 60): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export default async function opencodeInfinite(pi: ExtensionAPI) {
  const base = builtinProviders().find((provider) => provider.id === "opencode");
  const bun = findBun();
  if (!base || !bun) return;

  const port = 40123 + Math.floor(Math.random() * 500);
  const egress = (process.env.OPENCODE_INFINITE_EGRESS ?? "WARP").toUpperCase();
  const session = process.env.OPENCODE_INFINITE_SESSION ?? opencodeSession();

  const gateway = spawn(bun, ["run", GATEWAY], {
    env: { ...process.env, OCI_GATEWAY_PORT: String(port), OCI_SESSION: session, OCI_EGRESS: egress },
    stdio: ["ignore", "ignore", "pipe"],
  });
  gateway.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) console.error(`[nomad] ${line}`);
  });
  const stop = () => gateway.kill("SIGTERM");
  process.on("exit", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const ready = await waitHealthy(port);
  if (!ready) {
    stop();
    return;
  }

  const endpoint = `http://127.0.0.1:${port}/v1`;
  const models = base.getModels().map((model) => ({ ...model, provider: "opencode", baseUrl: endpoint }));

  const provider = {
    ...base,
    name: "OpenCode (Infinite)",
    auth: {
      apiKey: {
        name: "OpenCode free tier",
        check: async () => ({ source: "public", type: "api_key" as const }),
        resolve: async () => ({ auth: { apiKey: "public" }, source: "public" }),
      },
    },
    getModels: () => models,
  };
  (pi.registerProvider as (value: unknown) => void)(provider);

  pi.registerCommand("opencode", {
    description: "OpenCode Infinite: status | rotate",
    handler: async (args, ctx) => {
      const [action = "status"] = args.trim().split(/\s+/).filter(Boolean);
      try {
        const path = action === "rotate" ? "/rotate" : "/health";
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        const data = (await response.json()) as Record<string, unknown>;
        ctx.ui.notify(`nomad ${JSON.stringify(data)}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
