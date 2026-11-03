import { patchBody } from "./gateway.ts";

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

console.log("selfcheck ok");
