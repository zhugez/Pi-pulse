import { patchBody, aggregateSse } from "./gateway.ts";

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

console.log("selfcheck ok");
