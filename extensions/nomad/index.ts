import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Provider } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const BUN_CANDIDATES = [join(homedir(), ".bun/bin/bun"), "/usr/local/bin/bun", "/usr/bin/bun"];
const GATEWAY = join(import.meta.dirname, "gateway.ts");

function findBun(): string | undefined {
  for (const path of BUN_CANDIDATES) if (existsSync(path)) return path;
  try {
    return execFileSync("command", ["-v", "bun"], { shell: "/bin/sh", encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function waitHealthy(port: number, nonce: string, tries = 60): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      // A gateway from another session may already own this port; only our own nonce counts.
      if (response.ok && ((await response.json()) as { nonce?: string }).nonce === nonce) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function startGateway(bun: string): Promise<number> {
  // Random ports collide with gateways left by other sessions; try a few before giving up.
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 40123 + Math.floor(Math.random() * 20000);
    const nonce = crypto.randomUUID();
    const proc = spawn(bun, ["run", GATEWAY], {
      env: { ...process.env, OCI_GATEWAY_PORT: String(port), OCI_NONCE: nonce },
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.error(`[nomad] ${line}`);
    });
    // Keep the gateway out of our event loop: otherwise `pi -p` never exits while it runs.
    proc.unref();
    (proc.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    if (await waitHealthy(port, nonce)) {
      // SIGKILL: SIGTERM can be swallowed while the runtime is already tearing down, which orphans the gateway.
      const stop = () => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      };
      process.on("exit", stop);
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return port;
    }
    proc.kill("SIGTERM");
  }
  throw new Error("nomad: gateway did not start");
}

function failure(model: Model<string>, message: string): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: "opencode", model: model.id,
    timestamp: Date.now(), stopReason: "error", errorMessage: message,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function freeModels(base: Provider): Model<string>[] {
  const usable = (model: { id: string; api: string; type?: string }) =>
    model.id.endsWith("-free") && model.api === "openai-completions" && (model.type ?? "chat") === "chat";
  const models = new Map<string, Model<string>>();
  for (const model of base.getModels()) if (usable(model)) models.set(model.id, model);
  // Pi refreshes its own catalog from upstream while the bundled one lags behind; list the union so
  // free models that only the refreshed catalog knows about stay pickable.
  try {
    const store = JSON.parse(readFileSync(join(getAgentDir(), "models-store.json"), "utf8"));
    for (const model of store?.opencode?.models ?? []) {
      if (usable(model) && !models.has(model.id)) models.set(model.id, model as Model<string>);
    }
  } catch {}
  // Served by upstream but in neither catalog yet; drop these once a catalog lists them.
  const template = models.get("pulse-alpha-free");
  if (template && !models.has("crouton-alpha-free")) models.set("crouton-alpha-free", { ...template, id: "crouton-alpha-free", name: "Crouton Alpha Free" });
  return [...models.values()];
}

export default async function nomad(pi: ExtensionAPI) {
  const base = builtinProviders().find((provider) => provider.id === "opencode");
  const bun = findBun();
  if (!base || !bun) return;

  // Lazy: nothing is spawned until an opencode request actually arrives.
  let endpoint: Promise<string> | undefined;
  function ensure(): Promise<string> {
    endpoint ??= startGateway(bun as string).then((port) => `http://127.0.0.1:${port}/v1`);
    const current = endpoint;
    current.catch(() => {
      if (endpoint === current) endpoint = undefined;
    });
    return current;
  }

  function relay(model: Model<string>, open: (baseUrl: string) => AsyncIterable<unknown>): ReturnType<typeof createAssistantMessageEventStream> {
    const outer = createAssistantMessageEventStream();
    void (async () => {
      try {
        const baseUrl = await ensure();
        for await (const event of open(baseUrl)) outer.push(event as Parameters<typeof outer.push>[0]);
      } catch (error) {
        outer.push({ type: "error", reason: "error", error: failure(model, error instanceof Error ? error.message : String(error)) });
      } finally {
        outer.end();
      }
    })();
    return outer;
  }

  const models = freeModels(base);

  const provider = {
    ...base,
    name: "OpenCode (Infinite)",
    getModels: () => models,
    auth: {
      apiKey: {
        name: "OpenCode free tier",
        check: async () => ({ source: "public", type: "api_key" as const }),
        resolve: async () => ({ auth: { apiKey: "public" }, source: "public" }),
      },
    },
    stream: (model: Model<string>, context: never, options: never) =>
      relay(model, (baseUrl) => base.stream({ ...model, baseUrl } as Model<never>, context, options)),
    streamSimple: (model: Model<string>, context: never, options: never) =>
      relay(model, (baseUrl) => base.streamSimple({ ...model, baseUrl } as Model<never>, context, options)),
  };
  (pi.registerProvider as (value: unknown) => void)(provider satisfies Provider);

  pi.registerCommand("opencode", {
    description: "nomad: status",
    handler: async (_args, ctx) => {
      if (!endpoint) {
        ctx.ui.notify("nomad: gateway not started; it starts on the first opencode request.", "info");
        return;
      }
      try {
        const url = (await endpoint).replace(/\/v1$/, "/health");
        ctx.ui.notify(`nomad ${JSON.stringify(await (await fetch(url)).json())}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
