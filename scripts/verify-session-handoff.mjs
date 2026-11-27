import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = await mkdtemp(join(tmpdir(), "pi-handoff-cli-"));
const agent = join(work, "agent");
const sessions = join(work, "sessions");
const log = join(work, "requests.jsonl");
await mkdir(agent);
await mkdir(sessions);
const live = process.argv.includes("--live");
const trace = [];
let server;
let verificationMode = "tool-call";
const counts = new Map();
let finalResponseAutoResume = false;

function emitResponse(res, item) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
	const response = { id: `resp_${Date.now()}`, status: "completed", output: [item], usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } };
	send({ type: "response.created", response: { ...response, status: "in_progress", output: [] } });
	send({ type: "response.output_item.added", output_index: 0, item: { ...item, ...(item.type === "function_call" ? { arguments: "" } : { content: [] }) } });
	if (item.type === "function_call") send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments });
	else {
		send({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
		send({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
	}
	send({ type: "response.output_item.done", output_index: 0, item });
	send({ type: "response.completed", response });
	res.end();
}
const textItem = text => ({ id: `msg_${Date.now()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const callItem = file => ({ id: `fc_${Date.now()}`, call_id: `call_${Date.now()}`, type: "function_call", name: "bash", arguments: JSON.stringify({ command: `printf 'once\\n' >> ${file}` }), status: "completed" });

try {
	let modelId = "handoff-test";
	if (live) {
		const sourceDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, ".pi", "agent");
		const config = JSON.parse(await readFile(join(sourceDir, "models.json"), "utf8"));
		assert.ok(config.providers?.xingchiapi, "XingchiAPI must already be configured");
		await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { xingchiapi: config.providers.xingchiapi } }), { mode: 0o600 });
		try { await writeFile(join(agent, "auth.json"), await readFile(join(sourceDir, "auth.json")), { mode: 0o600 }); } catch (error) { if (error.code !== "ENOENT") throw error; }
		modelId = "gpt-6.1-sol";
	} else {
		server = createServer(async (req, res) => {
			try {
				let body = "";
				for await (const chunk of req) body += chunk;
				const data = JSON.parse(body);
				const id = data.prompt_cache_key;
				trace.push({ key: id ?? null, sessionHeader: req.headers["session-id"] ?? null, assistantItems: data.input.filter(i => i.role === "assistant" || i.type === "function_call").length });
				const input = JSON.stringify(data.input);
				if (!id) {
					const completed = input.includes("All requested writes completed once.") || input.includes("FINAL_CASE_DONE");
					const summary = completed
						? "Handoff status: stop\nThe requested writes are complete."
						: "Handoff status: continue\nThe authorized task still has a remaining write. Verify it in the replacement session.";
					return emitResponse(res, textItem(summary));
				}
				const count = counts.get(id) ?? 0;
				counts.set(id, count + 1);
				if (verificationMode === "final-response") {
					if (counts.size === 1) emitResponse(res, textItem("FINAL_CASE_PENDING: remaining.txt still needs the authorized write."));
					else emitResponse(res, count === 0 ? callItem("remaining.txt") : textItem("FINAL_CASE_DONE: remaining.txt was written once."));
				} else if (counts.size === 1) emitResponse(res, callItem(count === 0 ? "first.txt" : "second.txt"));
				else emitResponse(res, count === 0 ? callItem("second.txt") : textItem("All requested writes completed once."));
			} catch (error) { res.writeHead(500); res.end(String(error)); }
		});
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { xingchiapi: { api: "openai-responses", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "local-test", models: [{ id: modelId, name: "Handoff test", contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text"] }] } } }));
	}
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: [], compaction: { enabled: false }, retry: { enabled: false } }));
	const traceExtension = join(work, "trace.ts");
	await writeFile(traceExtension, `import { appendFileSync } from "node:fs";
export default function(pi) {
 pi.on("before_provider_request", (event,ctx) => {
  const data = Object.values(event).find(v => v && typeof v === "object" && "model" in v && "input" in v);
  if (data) appendFileSync(${JSON.stringify(log)}, JSON.stringify({session:ctx.sessionManager.getSessionId(), key:data.prompt_cache_key ?? null, assistantItems:data.input.filter(i => i.role === "assistant" || i.type === "function_call").length})+"\\n");
 });
 pi.on("agent_settled", (_event,ctx) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({kind:"settled", session:ctx.sessionManager.getSessionId(), turns:ctx.sessionManager.getEntries().filter(e => e.type === "message" && e.message.role === "assistant" && e.message.provider === "xingchiapi").length, provider:ctx.model?.provider, flag:pi.getFlag("session-handoff-turns"), idle:ctx.isIdle(), pending:ctx.hasPendingMessages()})+"\\n"));
}`);
	const old = SessionManager.create(work, sessions);
	if (live) {
		old.appendMessage({ role: "user", content: "Remember HANDOFF_CANARY_47. The authorized task is to reply with this exact canary when asked. No file or shell actions are authorized.", timestamp: Date.now() });
		old.appendMessage({ role: "assistant", api: "openai-responses", provider: "xingchiapi", model: modelId, content: [{ type: "text", text: "Recorded the canary." }], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	}
	const args = ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "-e", join(root, "extensions/session-handoff/index.ts"), "-e", traceExtension, "--provider", "xingchiapi", "--model", modelId, "--thinking", "low", "--session-handoff-turns", "2", "--session", old.getSessionFile(), "--session-dir", sessions, "--mode", "json", "-p", "--system-prompt", "Follow the user's exact request. Execute only authorized actions. Never repeat a completed write."];
	if (live) args.push("--no-tools", "Reply with the recorded canary. Then stop.");
	else args.push("--tools", "bash", "Append the line once to first.txt, then once to second.txt. Execute each write separately. Later correction: never append to an existing file. Stop after both writes.");
	async function runPi(cliArgs, cwd = work) {
		let stdout = "", stderr = "";
		const child = spawn("pi", cliArgs, { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", data => { stdout += data; });
		child.stderr.on("data", data => { stderr += data; });
		const timer = setTimeout(() => child.kill("SIGTERM"), 150000);
		const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
		clearTimeout(timer);
		assert.equal(code, 0, `Pi exited unsuccessfully: ${stderr.slice(-2000)}`);
		assert.doesNotMatch(stderr, /Session handoff stopped|Extension error|Error loading/);
		const errors = stdout.split("\n").flatMap(line => {
			try { const e = JSON.parse(line); return e.type === "message_end" && e.message?.role === "assistant" && ["error", "aborted"].includes(e.message.stopReason) ? [e.message.errorMessage || e.message.stopReason] : []; } catch { return []; }
		});
		assert.deepEqual(errors, [], "Provider requests must complete successfully");
		return { stdout, stderr };
	}
	let { stdout, stderr } = await runPi(args);
	if (live) {
		let replacement;
		for (const file of await readdir(sessions)) {
			if (!file.endsWith(".jsonl")) continue;
			const entries = (await readFile(join(sessions, file), "utf8")).trim().split("\n").map(JSON.parse);
			if (entries.some(e => e.type === "custom" && e.customType === "pi-session-handoff" && !e.data?.failed)) replacement = join(sessions, file);
		}
		const diagnostics = [];
		if (!replacement) for (const file of await readdir(sessions)) {
			const entries = (await readFile(join(sessions, file), "utf8")).trim().split("\n").map(JSON.parse);
			diagnostics.push({ entries: entries.map(e => ({ type: e.type, customType: e.customType, role: e.message?.role, provider: e.message?.provider, stopReason: e.message?.stopReason })), output: stdout.slice(-500), trace: await readFile(log, "utf8"), stderr });
		}
		assert.ok(replacement, `A final response at the threshold must prepare a fresh idle session: ${JSON.stringify(diagnostics)}`);
		const nextArgs = [...args];
		nextArgs[nextArgs.indexOf("--session") + 1] = replacement;
		nextArgs[nextArgs.indexOf("--session-handoff-turns") + 1] = "0";
		const resumed = await runPi(nextArgs);
		assert.match(resumed.stdout, /HANDOFF_CANARY_47/);
		stdout += resumed.stdout;
		stderr += resumed.stderr;
	}
	const recorded = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse).filter(r => !r.kind);
	const keys = [...new Set(recorded.map(r => r.key).filter(Boolean))];
	assert.ok(keys.length >= 2, `Expected fresh provider affinity, got ${JSON.stringify(recorded)}; stderr=${stderr.slice(-1000)}`);
	assert.equal(recorded.find(r => r.key === keys[1]).assistantItems, 0, "replacement request must have no prior assistant turns");
	const files = await readdir(sessions);
	const histories = await Promise.all(files.filter(f => f.endsWith(".jsonl")).map(async f => (await readFile(join(sessions, f), "utf8")).trim().split("\n").map(JSON.parse)));
	assert.ok(histories.length >= 2);
	assert.ok(histories.some(entries => entries.some(e => e.type === "custom" && e.customType === "pi-session-handoff")));
	if (live) assert.match(stdout, /HANDOFF_CANARY_47/);
	else {
		assert.equal(await readFile(join(work, "first.txt"), "utf8"), "once\n");
		assert.equal(await readFile(join(work, "second.txt"), "utf8"), "once\n");
		assert.ok(trace.filter(r => r.key).every(r => r.key === r.sessionHeader), "session-id and cache affinity must agree");
	}
	if (!live) {
		verificationMode = "final-response";
		counts.clear();
		trace.length = 0;
		await writeFile(log, "");
		const finalWork = join(work, "final-response-work");
		const finalSessions = join(work, "final-response-sessions");
		await mkdir(finalWork);
		await mkdir(finalSessions);
		const source = SessionManager.create(finalWork, finalSessions);
		source.appendMessage({ role: "user", content: "Write remaining.txt exactly once. The task is unfinished until that file contains `once`.", timestamp: Date.now() });
		source.appendMessage({ role: "assistant", api: "openai-responses", provider: "xingchiapi", model: modelId, content: [{ type: "text", text: "The remaining write is still required." }], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		const finalArgs = [...args];
		finalArgs[finalArgs.indexOf("--session") + 1] = source.getSessionFile();
		finalArgs[finalArgs.indexOf("--session-dir") + 1] = finalSessions;
		finalArgs[finalArgs.length - 1] = "Review the task and report progress.";
		await runPi(finalArgs, finalWork);
		const histories = await Promise.all((await readdir(finalSessions)).filter(file => file.endsWith(".jsonl")).map(async file => ({
			file,
			entries: (await readFile(join(finalSessions, file), "utf8")).trim().split("\n").map(JSON.parse),
		})));
		const replacement = histories.find(({ entries }) => entries.some(entry => entry.type === "custom" && entry.customType === "pi-session-handoff" && entry.data?.fromSessionId === source.getSessionId()));
		assert.ok(replacement, "The final-response handoff must create a replacement session.");
		assert.ok(replacement.entries.some(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "bash"), "The replacement session must execute unfinished work automatically.");
		assert.equal(await readFile(join(finalWork, "remaining.txt"), "utf8"), "once\n");
		const replacementId = replacement.entries.find(entry => entry.type === "session")?.id;
		const requests = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse).filter(entry => !entry.kind);
		assert.ok(requests.some(entry => entry.session === replacementId && entry.assistantItems === 0), "The replacement request must start without old assistant turns.");
		finalResponseAutoResume = true;
	}
	console.log(JSON.stringify({ mode: live ? "live-xingchiapi" : "local-cli", providerSessions: keys.length, requests: recorded.length, firstReplacementAssistantItems: 0, preservedSource: files.includes(old.getSessionFile().split("/").at(-1)), writesExactlyOnce: !live, finalResponseAutoResume, status: "passed" }));
} finally {
	if (server) await new Promise(resolve => server.close(resolve));
	await rm(work, { recursive: true, force: true });
}
