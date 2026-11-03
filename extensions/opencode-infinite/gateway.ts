const UPSTREAM = "https://opencode.ai/inference/openai";
const PORT = Number(process.env.OCI_GATEWAY_PORT ?? 40123);
const SESSION = process.env.OCI_SESSION ?? "";
const EGRESS = (process.env.OCI_EGRESS ?? "WARP").toUpperCase();
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
  return JSON.stringify(parsed);
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
  const body = path.includes("chat/completions") ? patchBody(raw, dir) : raw;
  const headers = outHeaders(req.headers);
  const proxy = proxyUrl();
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
}

if (import.meta.main) Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, egress: EGRESS, session: SESSION, rotations, lastIp });
    }
    if (url.pathname === "/rotate") {
      const ip = await rotate();
      return Response.json({ ok: true, ip, rotations });
    }
    return forward(url.pathname, req);
  },
});

if (import.meta.main) console.error(`[gateway] listening on 127.0.0.1:${PORT} egress=${EGRESS} session=${SESSION || "none"}`);
