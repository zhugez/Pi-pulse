import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { createRequire } from "node:module";

// Bun replaces bare `undici` with a shim that does not implement SOCKS dispatchers.
const { fetch: proxyFetch, ProxyAgent } = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");

const exec = promisify(execFile);

export async function torNewnym(port: number, password: string): Promise<void> {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(5000, () => socket.destroy(new Error("Tor control timeout")));
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  const replies = lines[Symbol.asyncIterator]();
  try {
    // Send NEWNYM only after authentication succeeds. JSON quoting escapes control characters.
    for (const command of [`AUTHENTICATE ${JSON.stringify(password)}`, "SIGNAL NEWNYM"]) {
      socket.write(`${command}\r\n`);
      const reply = await replies.next();
      if (reply.done || reply.value !== "250 OK") throw new Error(`Tor control rejected ${command.split(" ")[0]}`);
    }
  } finally {
    lines.close();
    socket.destroy();
  }
}

export function createEgress(
  env: Record<string, string | undefined> = process.env,
  run: (args: string[]) => Promise<string> = async (args) => (await exec("warp-cli", ["--accept-tos", ...args], { timeout: 10000 })).stdout,
  readIp?: (proxy: string) => Promise<string>,
  newnym = torNewnym,
) {
  const mode = (env.OCI_EGRESS ?? env.OPENCODE_INFINITE_EGRESS ?? "NONE").toUpperCase();
  if (!["NONE", "WARP", "TOR"].includes(mode)) throw new Error("OCI_EGRESS must be NONE, WARP or TOR");
  function integer(name: string, fallback: number, max: number): number {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
    return value;
  }
  const proxy = mode === "WARP" ? `http://127.0.0.1:${integer("OCI_WARP_PORT", 40000, 65535)}`
    : mode === "TOR" ? `socks5://127.0.0.1:${integer("OCI_TOR_PORT", 9050, 65535)}` : undefined;
  const controlPort = integer("OCI_TOR_CONTROL_PORT", 9051, 65535);
  const maxAttempts = integer("OCI_MAX_ATTEMPTS", 4, 10);
  let rotations = 0;
  let lastIp = "";
  let pending: Promise<string> | undefined;
  let dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  async function routedFetch(url: string, init: RequestInit & { headers?: Headers } = {}): Promise<Response> {
    if (!dispatcher) return fetch(url, init);
    const response = await proxyFetch(url, { ...init, body: init.body as string | undefined, dispatcher });
    return new Response(response.body as ReadableStream<Uint8Array> | null, {
      status: response.status, statusText: response.statusText, headers: [...response.headers],
    });
  }
  const currentIp = readIp ?? (async (_url: string) => {
    const response = await routedFetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`IP lookup failed: ${response.status}`);
    const ip = (await response.text()).match(/^ip=(.+)$/m)?.[1]?.trim();
    if (!ip) throw new Error("IP lookup returned no address");
    return ip;
  });

  async function performRotation(): Promise<string> {
    if (!proxy) throw new Error("Rotation disabled. Set OPENCODE_INFINITE_EGRESS=WARP or TOR before starting Pi.");
    const before = await currentIp(proxy);
    lastIp = before;
    if (mode === "WARP") {
      // Preserve the existing registration and proxy configuration.
      const settings = await run(["settings"]);
      if (!/\bMode:\s*(?:WarpProxy|proxy)\b/i.test(settings)) throw new Error("Configure WARP proxy mode before rotating");
      await run(["disconnect"]);
      await run(["connect"]);
    } else {
      await newnym(controlPort, env.OCI_TOR_CONTROL_PASSWORD ?? "");
    }
    await dispatcher?.close();
    dispatcher = new ProxyAgent(proxy);
    // NEWNYM and WARP reconnect do not guarantee another exit address.
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(1000);
      try {
        lastIp = await currentIp(proxy);
        if (lastIp !== before) {
          rotations++;
          return lastIp;
        }
      } catch {
        // The proxy may be unavailable while it reconnects; retry within this bounded window.
      }
    }
    throw new Error(`${mode}: exit IP did not change or proxy remained unavailable`);
  }

  function rotate(): Promise<string> {
    // ponytail: coalesce per gateway; use an OS lock if multiple Pi processes rotate the same proxy.
    if (!pending) {
      pending = performRotation().finally(() => { pending = undefined; });
    }
    return pending;
  }

  async function send(request: () => Promise<Response>): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const response = await request();
      if (!proxy || response.status !== 429 || attempt >= maxAttempts) return response;
      const text = await response.clone().text();
      if (!/FreeUsageLimitError|free-limit/i.test(text)) return response;
      try {
        await rotate();
      } catch (error) {
        console.error(`[nomad] rotation failed: ${error instanceof Error ? error.message : String(error)}`);
        return response;
      }
      await response.body?.cancel();
    }
  }

  return { proxy, rotate, send, fetch: routedFetch, close: () => dispatcher?.close(), status: () => ({ egress: mode, rotations, lastIp }) };
}
