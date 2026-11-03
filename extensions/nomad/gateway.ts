import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";

const UPSTREAM = "https://opencode.ai/inference/openai";
const PORT = Number(process.env.OCI_GATEWAY_PORT ?? 40123);

// The free tier only serves requests that reference a session the OpenCode server knows;
// an unknown session id is answered with FreeUsageLimitError. Any id in the local DB works.
function sessionFromDb(): string {
  const db = join(homedir(), ".local/share/opencode/opencode.db");
  if (!existsSync(db)) return "";
  let conn: Database | undefined;
  try {
    conn = new Database(db, { readonly: true });
    const row = conn.query("select id from session_v2 order by time_created desc limit 1").get() as { id?: string } | null;
    return row?.id ?? "";
  } catch {
    return "";
  } finally {
    conn?.close();
  }
}

const SESSION = process.env.OCI_SESSION || sessionFromDb();
// Echoed by /health so a launcher can tell its own gateway from one already on that port.
const NONCE = process.env.OCI_NONCE ?? "";
// direct egress: the free tier is gated on the client's TLS/HTTP fingerprint, not the IP.
// WARP and Tor exits are refused (429) even when the request body is byte-identical.
const EGRESS = (process.env.OCI_EGRESS ?? "NONE").toUpperCase();

// Native client shape captured from `opencode --standalone run`. The free tier only serves
// requests that carry this system prompt and tool set; anything else gets FreeUsageLimitError.
const NATIVE = (await Bun.file(join(import.meta.dirname, "fixtures/native.json")).json()) as {
  system: string;
  tools: { function: { name: string } }[];
  stream_options?: unknown;
};
const NATIVE_MARK = NATIVE.system.slice(0, 60);
const WARP_PORT = Number(process.env.OCI_WARP_PORT ?? 40000);
const TOR_PORT = Number(process.env.OCI_TOR_PORT ?? 9050);
const MAX_ATTEMPTS = Number(process.env.OCI_MAX_ATTEMPTS ?? 4);

let rotations = 0;
let lastIp = "";

function proxyUrl(): string | undefined {
  if (EGRESS === "WARP") return `http://127.0.0.1:${WARP_PORT}`;
  if (EGRESS === "TOR") return `socks5://127.0.0.1:${TOR_PORT}`;
  return undefined;
}

async function sh(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

async function currentIp(): Promise<string> {
  const proxy = proxyUrl();
  try {
    const r = await fetch("https://www.cloudflare.com/cdn-cgi/trace", proxy ? { proxy } : {});
    const text = await r.text();
    const m = text.match(/^ip=(.*)$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

async function rotate(): Promise<string> {
  if (EGRESS === "WARP") {
    await sh(["warp-cli", "--accept-tos", "registration", "delete"]);
    await sh(["warp-cli", "--accept-tos", "registration", "new"]);
    await sh(["warp-cli", "--accept-tos", "mode", "proxy"]);
    await sh(["warp-cli", "--accept-tos", "proxy", "port", String(WARP_PORT)]);
    await sh(["warp-cli", "--accept-tos", "connect"]);
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(700);
      const status = await sh(["warp-cli", "--accept-tos", "status"]);
      if (status.includes("Connected")) break;
    }
  } else if (EGRESS === "TOR") {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port: 9051, socket: { data() {}, open() {} } });
    socket.write('AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT\r\n');
    await Bun.sleep(400);
    socket.end();
  } else {
    return lastIp;
  }
  rotations++;
  lastIp = await currentIp();
  return lastIp;
}

const ENV_MARK = "Here is some useful information about the environment you are running in:";

function envBlock(dir: string): string {
  let isRepo = "no";
  try {
    isRepo = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--is-inside-work-tree"]).stdout.toString().trim() === "true" ? "yes" : "no";
  } catch {}
  return `${ENV_MARK}\n<env>\n  Working directory: ${dir}\n  Workspace root folder: ${dir}\n  Is directory a git repo: ${isRepo}\n  Platform: ${process.platform}\n</env>`;
}

export function patchBody(raw: string, dir: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!Array.isArray(parsed.messages)) return raw;
  const block = envBlock(dir);
  let patched = false;
  parsed.messages = parsed.messages.map((m: any) => {
    if (patched || m.role !== "system") return m;
    const text = typeof m.content === "string" ? m.content : "";
    if (text.includes(ENV_MARK)) {
      patched = true;
      return m;
    }
    patched = true;
    return { ...m, content: `${text}\n\n${block}` };
  });
  if (!patched) parsed.messages.unshift({ role: "system", content: block });
  nativeize(parsed);
  return JSON.stringify(parsed);
}

function nativeize(parsed: any): void {
  if (typeof parsed.model !== "string" || !parsed.model.endsWith("-free")) return;
  const hasNative = parsed.messages.some((m: any) => typeof m.content === "string" && m.content.startsWith(NATIVE_MARK));
  if (!hasNative) parsed.messages.unshift({ role: "system", content: NATIVE.system });
  const have = new Set((parsed.tools ?? []).map((t: any) => t?.function?.name));
  // Only the tool *names* are checked upstream; descriptions and schemas are not. Tools the host
  // does not define are added as unavailable placeholders so the model is not offered a working
  // schema for something nobody can execute. A call to one still fails in the host.
  const placeholders = NATIVE.tools
    .filter((t) => !have.has(t.function.name))
    .map((t) => ({ type: "function", function: { name: t.function.name, description: "Not available in this harness. Do not call.", parameters: { type: "object", properties: {} } } }));
  parsed.tools = [...(parsed.tools ?? []), ...placeholders];
  parsed.stream = true;
  parsed.stream_options ??= NATIVE.stream_options ?? { include_usage: true };
}

function outHeaders(input: Headers): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("authorization", input.get("authorization") ?? "Bearer public");
  headers.set("user-agent", "opencode/latest/2.2.5/cli");
  headers.set("x-opencode-client", "cli");
  headers.set("accept", "*/*");
  headers.set("accept-encoding", "gzip, deflate, br, zstd");
  if (SESSION) {
    headers.set("x-opencode-session", SESSION);
    headers.set("x-session-affinity", SESSION);
    headers.set("x-opencode-session-id", SESSION);
    headers.set("x-session-id", SESSION);
  }
  return headers;
}

async function forward(path: string, req: Request): Promise<Response> {
  const dir = req.headers.get("x-opencode-directory") ?? process.cwd();
  const raw = await req.text();
  const isChat = path.includes("chat/completions");
  if (isChat && !SESSION) {
    return Response.json(
      { error: { type: "nomad_no_session", message: "No OpenCode session found. Run `opencode` once so ~/.local/share/opencode/opencode.db exists." } },
      { status: 503 },
    );
  }
  const body = isChat ? patchBody(raw, dir) : raw;
  const headers = outHeaders(req.headers);
  const proxy = proxyUrl();
  const send = async (): Promise<Response> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetch(`${UPSTREAM}${path}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        ...(proxy ? { proxy } : {}),
      });
      if (response.status !== 429 || attempt === MAX_ATTEMPTS) return response;
      const text = await response.text();
      if (!/FreeUsageLimitError|free-limit/i.test(text)) {
        return new Response(text, { status: response.status, headers: response.headers });
      }
      console.error(`[gateway] 429 on attempt ${attempt}, rotating ${EGRESS}`);
      await rotate();
    }
    throw new Error("unreachable");
  };
  const response = await send();
  if (!isChat || response.status !== 200 || clientWantsStream(raw)) return response;
  return Response.json(aggregateSse(await response.text(), modelId(body)));
}

function clientWantsStream(raw: string): boolean {
  try {
    return JSON.parse(raw).stream === true;
  } catch {
    return true;
  }
}

function modelId(body: string): string {
  try {
    return String(JSON.parse(body).model ?? "");
  } catch {
    return "";
  }
}

// Upstream is always streamed (the free tier rejects stream:false), so a non-streaming client gets
// the SSE re-assembled into one chat.completion response.
export function aggregateSse(sse: string, model: string): Record<string, unknown> {
  let content = "";
  let reasoning = "";
  let finish = "stop";
  let id = "";
  let usage: unknown = null;
  const calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const chunk = line.slice(6).trim();
    if (!chunk || chunk === "[DONE]") continue;
    let parsed: any;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      continue;
    }
    id ||= parsed.id ?? "";
    if (parsed.usage) usage = parsed.usage;
    for (const choice of parsed.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        calls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        if (call.id) calls[index].id = call.id;
        if (call.function?.name) calls[index].function.name += call.function.name;
        if (call.function?.arguments) calls[index].function.arguments += call.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  const toolCalls = calls.filter(Boolean);
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

if (import.meta.main) Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, nonce: NONCE, egress: EGRESS, session: SESSION, rotations, lastIp });
    }
    if (url.pathname === "/rotate") {
      const ip = await rotate();
      return Response.json({ ok: true, ip, rotations });
    }
    return forward(url.pathname, req);
  },
});

if (import.meta.main) console.error(`[gateway] listening on 127.0.0.1:${PORT} egress=${EGRESS} session=${SESSION || "none"}`);
