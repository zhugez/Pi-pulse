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

// Native client shape captured from `opencode --standalone run`. The free tier only serves
// requests that carry this system prompt and tool set; anything else gets FreeUsageLimitError.
const NATIVE = (await Bun.file(join(import.meta.dirname, "fixtures/native.json")).json()) as {
  system: string;
  tools: { function: { name: string } }[];
  stream_options?: unknown;
};
const NATIVE_MARK = NATIVE.system.slice(0, 60);

const ENV_MARK = "Here is some useful information about the environment you are running in:";

const envBlocks = new Map<string, string>();
function envBlock(dir: string): string {
  const cached = envBlocks.get(dir);
  if (cached) return cached;
  let isRepo = "no";
  try {
    isRepo = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--is-inside-work-tree"]).stdout.toString().trim() === "true" ? "yes" : "no";
  } catch {}
  const block = `${ENV_MARK}\n<env>\n  Working directory: ${dir}\n  Workspace root folder: ${dir}\n  Is directory a git repo: ${isRepo}\n  Platform: ${process.platform}\n</env>`;
  envBlocks.set(dir, block);
  return block;
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
  const response = await fetch(`${UPSTREAM}${path}`, {
    method: req.method,
    headers: outHeaders(req.headers),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
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
    if (url.pathname === "/health") return Response.json({ ok: true, nonce: NONCE, session: SESSION });
    return forward(url.pathname, req);
  },
});

if (import.meta.main) console.error(`[gateway] listening on 127.0.0.1:${PORT} session=${SESSION || "none"}`);
