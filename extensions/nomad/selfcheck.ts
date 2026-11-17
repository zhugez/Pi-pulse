import { patchBody, aggregateSse } from "./gateway.ts";
import { createEgress, torNewnym } from "./egress.ts";
import assert from "node:assert/strict";
import { createServer } from "node:net";

const sys = "You are pi.";
const body = JSON.stringify({ model: "m", messages: [{ role: "system", content: sys }, { role: "user", content: "hi" }] });
const patched = JSON.parse(patchBody(body, "/home/dev"));
if (!patched.messages[0].content.includes("Working directory: /home/dev")) throw new Error("env block not injected");
if (patched.messages[1].content !== "hi") throw new Error("user message mutated");

const twice = JSON.parse(patchBody(patchBody(body, "/home/dev"), "/home/dev"));
const marks = twice.messages[0].content.split("Here is some useful information").length - 1;
if (marks !== 1) throw new Error(`env block duplicated: ${marks}`);

const noSystem = JSON.parse(patchBody(JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }), "/tmp"));
if (noSystem.messages[0].role !== "system") throw new Error("env block not prepended");
if (patchBody("not json", "/tmp") !== "not json") throw new Error("invalid json should pass through");

const free = JSON.parse(patchBody(JSON.stringify({ model: "x-free", messages: [{ role: "user", content: "hi" }] }), "/tmp"));
if (!free.messages[0].content.startsWith("You are an AI agent running in OpenCode")) throw new Error("native system prompt not injected");
if (free.tools.length < 10) throw new Error("native tools not merged");
if (free.stream !== true) throw new Error("stream not forced");
const twiceFree = JSON.parse(patchBody(patchBody(JSON.stringify({ model: "x-free", messages: [{ role: "user", content: "hi" }] }), "/tmp"), "/tmp"));
if (twiceFree.messages.filter((m: any) => m.content.startsWith("You are an AI agent running in OpenCode")).length !== 1)
  throw new Error("native system prompt duplicated");
if (new Set(twiceFree.tools.map((t: any) => t.function.name)).size !== twiceFree.tools.length)
  throw new Error("native tools duplicated on re-patch");

const placeholder = free.tools.find((t: any) => t.function.name === "webfetch");
if (!placeholder || !placeholder.function.description.includes("Not available")) throw new Error("foreign native tool not placeholder");
if (Object.keys(placeholder.function.parameters.properties).length !== 0) throw new Error("placeholder exposes a schema");
const kept = JSON.parse(patchBody(JSON.stringify({ model: "x-free", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "read", description: "mine", parameters: {} } }] }), "/tmp"));
if (kept.tools.find((t: any) => t.function.name === "read").function.description !== "mine")
  throw new Error("host tool shadowed by native tool");

const sse = [
  'data: {"id":"x","choices":[{"delta":{"role":"assistant","content":"he"}}]}',
  'data: {"id":"x","choices":[{"delta":{"content":"llo"}}]}',
  'data: {"id":"x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ba","arguments":"{\\"comm"}}]}}]}',
  'data: {"id":"x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"sh","arguments":"and\\":\\"ls\\"}"}},{"index":1,"id":"c2","function":{"name":"read","arguments":"{}"}}]}}]}',
  'data: {"id":"x","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"total_tokens":3}}',
  "data: [DONE]",
].join("\n");
const out = aggregateSse(sse, "m") as any;
if (out.choices[0].message.content !== "hello") throw new Error("sse aggregation lost content");
if (out.usage.total_tokens !== 3) throw new Error("sse aggregation lost usage");
if (out.choices[0].finish_reason !== "tool_calls") throw new Error("sse aggregation lost finish reason");
const calls = out.choices[0].message.tool_calls;
if (calls.length !== 2) throw new Error(`expected 2 tool calls, got ${calls.length}`);
if (calls[0].function.name !== "bash") throw new Error(`fragmented tool name: ${calls[0].function.name}`);
if (calls[0].function.arguments !== '{"command":"ls"}') throw new Error(`fragmented arguments: ${calls[0].function.arguments}`);
if (calls[1].function.name !== "read" || calls[1].id !== "c2") throw new Error("second tool call lost");

const usageOnly = aggregateSse('data: {"id":"y","choices":[],"usage":{"total_tokens":9}}\ndata: [DONE]\n', "m") as any;
if (usageOnly.usage.total_tokens !== 9) throw new Error("usage-only chunk dropped");

const direct = createEgress({});
assert.equal(direct.proxy, undefined);
await assert.rejects(direct.rotate(), /Rotation disabled/);
assert.throws(() => createEgress({ OCI_EGRESS: "invalid" }));
assert.throws(() => createEgress({ OCI_EGRESS: "TOR", OCI_TOR_PORT: "NaN" }));
assert.throws(() => createEgress({ OCI_MAX_ATTEMPTS: "0" }));
const limited = new Response('{"error":"FreeUsageLimitError"}', { status: 429 });
assert.equal(await direct.send(async () => limited), limited);

const commands: string[][] = [];
let ipReads = 0;
const warp = createEgress({ OPENCODE_INFINITE_EGRESS: "warp", OCI_WARP_PORT: "40001" },
  async (args) => { commands.push(args); return "Mode: WarpProxy"; },
  async () => ++ipReads === 1 ? "192.0.2.1" : "192.0.2.2");
assert.equal(warp.proxy, "http://127.0.0.1:40001");
const rotation = warp.rotate();
assert.equal(warp.rotate(), rotation);
await rotation;
assert.deepEqual(commands, [["settings"], ["disconnect"], ["connect"]]);
assert.equal(warp.status().rotations, 1);

let signals = 0;
ipReads = 0;
const tor = createEgress({ OCI_EGRESS: "TOR", OCI_MAX_ATTEMPTS: "2", OCI_TOR_CONTROL_PORT: "19051", OCI_TOR_CONTROL_PASSWORD: "secret" },
  undefined, async () => `192.0.2.${++ipReads}`,
  async (port, password) => { assert.equal(port, 19051); assert.equal(password, "secret"); signals++; });
assert.equal(tor.proxy, "socks5://127.0.0.1:9050");
let attempts = 0;
const success = await tor.send(async () => ++attempts === 1 ? limited.clone() : new Response("ok"));
assert.equal(await success.text(), "ok");
assert.equal(attempts, 2);
assert.equal(signals, 1);
attempts = 0;
await tor.send(async () => { attempts++; return limited.clone(); });
assert.equal(attempts, 2);
const beforeSignals = signals;
for (const response of [new Response("ModelDeprecated", { status: 429 }), new Response("FreeUsageLimitError", { status: 500 })]) {
  assert.equal(await tor.send(async () => response), response);
}
assert.equal(signals, beforeSignals);
const broken = createEgress({ OCI_EGRESS: "WARP" }, async () => { throw new Error("mock WARP failed"); }, async () => "192.0.2.1");
assert.equal(await broken.send(async () => limited), limited);
assert.equal(broken.status().rotations, 0);
const unchanged = createEgress({ OCI_EGRESS: "TOR" }, undefined, async () => "192.0.2.1", async () => {});
await assert.rejects(unchanged.rotate(), /exit IP did not change/);
assert.equal(unchanged.status().rotations, 0);
await assert.rejects(torNewnym(1, ""), /ECONNREFUSED/);

for (const authenticated of [true, false]) {
  const received: string[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        received.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        socket.write(authenticated ? "250 OK\r\n" : "515 Authentication failed\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    if (authenticated) await torNewnym(address.port, 'a"b');
    else await assert.rejects(torNewnym(address.port, 'a"b'), /rejected AUTHENTICATE/);
    assert.deepEqual(received, authenticated ? ['AUTHENTICATE "a\\"b"', "SIGNAL NEWNYM"] : ['AUTHENTICATE "a\\"b"']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
console.log("selfcheck ok");
