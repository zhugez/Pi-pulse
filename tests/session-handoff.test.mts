import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import sessionHandoff, { HANDOFF_ENTRY, handoffThreshold, handoffState, providerTurns } from "../extensions/session-handoff/index.ts";
import { GoalScheduler } from "../extensions/goal/goal-scheduler.ts";
import type { GoalCore } from "../extensions/goal/goal-state.ts";
import type { GoalRecord } from "../extensions/goal/goal-record.ts";

const response = (text = "done") => ({ role: "assistant" as const, api: "openai-responses" as const, provider: "xingchiapi", model: "test", content: [{ type: "text" as const, text }], stopReason: "stop" as const, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

test("handoff threshold validates configuration and raw provider count survives compaction", () => {
	assert.equal(handoffThreshold(undefined), 80);
	for (const n of [0, 1, 80, 90]) assert.equal(handoffThreshold(String(n)), n);
	for (const value of ["", "-1", "91", "NaN", "2.5", "1e1"]) assert.throws(() => handoffThreshold(value));
	const sm = SessionManager.inMemory();
	sm.appendMessage(response());
	sm.appendMessage({ ...response(), provider: "other" });
	sm.appendMessage({ ...response(), stopReason: "error" });
	const leaf = sm.getLeafId()!;
	sm.appendCompaction("summary", leaf, 100);
	assert.equal(providerTurns(sm.getEntries()), 2);
});

test("handoff keeps only latest native goal, todo and mode state", () => {
	const sm = SessionManager.inMemory();
	sm.appendCustomEntry("pi-goal-focus", { focusedGoalId: "old" });
	sm.appendCustomEntry("pi-goal-focus", { focusedGoalId: "selected" });
	sm.appendCustomEntry("rpiv-todo-state", { tasks: [{ id: 1, status: "in_progress" }], nextId: 2 });
	sm.appendCustomEntry("ponytail-mode", { mode: "full" });
	sm.appendCustomEntry("unrelated-live-process", { pid: 123 });
	const state = handoffState(sm.getBranch());
	assert.deepEqual(state.map(s => s.customType).sort(), ["pi-goal-focus", "ponytail-mode", "rpiv-todo-state"]);
	assert.deepEqual(state.find(s => s.customType === "pi-goal-focus")?.data, { focusedGoalId: "selected" });
	assert.deepEqual(handoffState([])[0]?.data, { version: 1, focusedGoalId: null, reason: "selected" });
});

function fixture(t: test.TestContext, threshold = "2") {
	const dir = mkdtempSync(join(tmpdir(), "pi-handoff-test-"));
	const before = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before;
		rmSync(dir, { recursive: true, force: true });
	});
	const sm = SessionManager.inMemory(dir);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	const sent: string[] = [];
	const notices: string[] = [];
	const holds: unknown[] = [];
	const requests: unknown[] = [];
	const restored: unknown[] = [];
	let fresh: SessionManager | undefined;
	let summaryError = false;
	let summaryText = "Handoff status: continue\n## Next step\nPreserve original request and correction. Write remaining.txt once. Check: earlier command failed.";
	let cancelled = false;
	const pi = {
		on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, fn),
		registerFlag: () => {}, getFlag: () => threshold,
		registerCommand: (_name: string, config: { handler: typeof handler }) => { handler = config.handler; },
		events: { emit: (_name: string, data: unknown) => holds.push(data) },
		sendUserMessage: (text: string) => sent.push(text),
		appendEntry: (name: string, data: unknown) => sm.appendCustomEntry(name, data),
		getActiveTools: () => ["read", "write"],
		setModel: async (model: unknown) => { restored.push(model); return true; },
		setThinkingLevel: (level: unknown) => restored.push(level), setActiveTools: (tools: unknown) => restored.push(tools),
	};
	const context = {
		model: { provider: "xingchiapi", id: "test" }, thinkingLevel: "low", hasUI: true,
		sessionManager: sm, isIdle: () => true, hasPendingMessages: () => false, waitForIdle: async () => {},
		ui: { notify: (text: string) => notices.push(text) },
		modelRegistry: { find: (_provider: string, id: string) => ({ id }), streamSimple: (_model: unknown, input: unknown, options: unknown) => {
			requests.push({ input, options });
			return { result: async () => summaryError ? { ...response(), stopReason: "error", errorMessage: "summary offline" } : response(summaryText) };
		} },
		newSession: async (options: { setup: (sm: SessionManager) => Promise<void>; withSession: (ctx: unknown) => Promise<void> }) => {
			if (cancelled) return { cancelled: true };
			fresh = SessionManager.inMemory(dir);
			await options.setup(fresh);
			await handlers.get("session_shutdown")?.({}, context as unknown as ExtensionContext);
			await options.withSession({ ui: context.ui, sendUserMessage: async (text: string) => sent.push(text) });
			return { cancelled: false };
		},
	};
	const ctx = context as unknown as ExtensionCommandContext;
	sessionHandoff(pi as unknown as ExtensionAPI);
	return { dir, sm, ctx, sent, notices, holds, requests, restored,
		fire: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
		run: (args = "now") => handler(args, ctx), fresh: () => fresh,
		fail: () => { summaryError = true; }, setSummary: (text: string) => { summaryText = text; }, cancel: () => { cancelled = true; },
	};
}

test("restoration applies only to a new handoff and preserves later manual selections on reload", async t => {
	const h = fixture(t);
	h.sm.appendCustomEntry(HANDOFF_ENTRY, { modelProvider: "xingchiapi", modelId: "original", thinking: "low", activeTools: ["read"] });
	await h.fire("session_start", { reason: "reload" });
	await h.fire("session_start", { reason: "startup" });
	assert.deepEqual(h.restored, []);
	await h.fire("session_start", { reason: "new" });
	assert.deepEqual(h.restored, [{ id: "original" }, "low", ["read"]]);
});

test("threshold defers the whole tool batch and dispatches only after settlement", async t => {
	const h = fixture(t);
	await h.fire("session_start");
	h.sm.appendMessage(response());
	assert.equal(await h.fire("tool_call"), undefined);
	h.sm.appendMessage(response());
	for (let i = 0; i < 2; i++) assert.deepEqual(await h.fire("tool_call"), { block: true, terminate: true, reason: "Not executed: automatic session handoff. Reconsider this pending call in the replacement session." });
	assert.deepEqual(h.sent, []);
	await h.fire("agent_settled", { aborted: true });
	assert.deepEqual(h.sent, []);
	await h.fire("agent_settled", { aborted: false });
	await h.fire("agent_settled", { aborted: false });
	assert.deepEqual(h.sent, ["/session-handoff now"]);
});

test("a final response at the threshold resumes only when the summary says work remains", async t => {
	const h = fixture(t);
	await h.fire("session_start");
	h.sm.appendMessage({ role: "user", content: "Finish the authorized task and check both outputs.", timestamp: 1 });
	h.sm.appendMessage(response("The first output is ready."));
	h.sm.appendMessage(response("The second output still needs work."));
	h.setSummary("Handoff status: continue\n## Next step\nWrite the remaining output and check both files.");
	await h.fire("agent_settled", { aborted: false });
	assert.deepEqual(h.sent, ["/session-handoff now"]);
	await h.run();
	assert.deepEqual(h.sent, [
		"/session-handoff now",
		"Continue unfinished, previously authorized work from the session handoff. Check the recorded tool outcomes before acting. If work is complete or blocked on user input, report that and stop.",
	]);
	assert.ok(h.fresh());
});

test("a final response at the threshold stays idle when the summary says stop", async t => {
	const h = fixture(t);
	await h.fire("session_start");
	h.sm.appendMessage({ role: "user", content: "Finish the authorized task.", timestamp: 1 });
	h.sm.appendMessage(response("The task is complete."));
	h.sm.appendMessage(response("No further work remains."));
	h.setSummary("Handoff status: stop\nThe task is complete.");
	await h.fire("agent_settled", { aborted: false });
	await h.run();
	assert.deepEqual(h.sent, ["/session-handoff now"]);
	assert.match(h.notices.at(-1)!, /automatic continuation is not needed/);
	assert.ok(h.fresh());
});

test("handoff uses a fresh summary request, preserves state and creates private recovery checkpoint", async t => {
	const h = fixture(t);
	await h.fire("session_start");
	h.sm.appendMessage({ role: "user", content: "Original request. Later correction.", timestamp: 1 });
	h.sm.appendMessage(response("Completed previous write. Earlier check failed."));
	h.sm.appendCustomEntry("rpiv-todo-state", { tasks: [{ id: 7, status: "in_progress" }], nextId: 8 });
	await h.run();
	const fresh = h.fresh()!;
	assert.notEqual(fresh.getSessionId(), h.sm.getSessionId());
	assert.equal(providerTurns(fresh.getEntries()), 0);
	assert.equal(providerTurns(h.sm.getEntries()), 1);
	const request = h.requests[0] as { input: { messages: { role: string; content: string }[] }; options: { sessionId?: string } };
	assert.equal(request.options.sessionId, undefined);
	assert.deepEqual(request.input.messages.map(m => m.role), ["user"]);
	assert.match(request.input.messages[0]!.content, /Original request.*Later correction/s);
	const marker = fresh.getBranch().find(e => e.type === "custom" && e.customType === HANDOFF_ENTRY) as Extract<SessionEntry, { type: "custom" }>;
	const data = marker.data as { checkpoint: string; activeTools: string[] };
	assert.match(readFileSync(data.checkpoint, "utf8"), /remaining.txt/);
	assert.deepEqual(data.activeTools, ["read", "write"]);
	assert.deepEqual(handoffState(fresh.getBranch()).find(e => e.customType === "rpiv-todo-state")?.data, { tasks: [{ id: 7, status: "in_progress" }], nextId: 8 });
	if (process.platform !== "win32") assert.equal(statSync(data.checkpoint).mode & 0o777, 0o600);
	assert.equal(h.sent.length, 1);
});

test("goal handoff preserves allowance, transfers only selected ownership, and honors the hold", () => {
	for (const matched of [true, false]) {
		const sm = SessionManager.inMemory(tmpdir());
		sm.appendCustomEntry(HANDOFF_ENTRY, { fromSessionId: "old", goalId: matched ? "selected" : "different" });
		let goal = { id: "selected", status: "active", autoContinue: true, usage: { tokensUsed: 0, activeSeconds: 0 }, scheduler: { version: 1, owner: "old", used: 7, generation: "existing", phase: "ready", decision: { kind: "ready", purpose: "ready" } } } as GoalRecord;
		let queued = 0;
		let listener: ((event: unknown) => void) | undefined;
		const ctx = { cwd: tmpdir(), sessionManager: sm, ui: { notify: () => {} } } as unknown as ExtensionContext;
		const core = {
			state: { get goal() { return goal; } },
			pi: { events: { on: (name: string, fn: typeof listener) => { if (name === "pi:session-handoff:hold") listener = fn; return () => {}; } } },
			runtime: { clearContinuationState: () => {}, clearContinuationTimer: () => {}, queueContinuation: () => queued++ },
			reconcileFocusedGoalFromDisk: () => true, updateUI: () => {},
			interruption: { isHeld: () => false },
			goalService: { flushForAudit: () => undefined, isTurnBuffered: () => false, apply: (_ctx: unknown, input: { mutate: (g: GoalRecord) => GoalRecord }) => { goal = input.mutate(goal); return { ok: true, goal }; } },
		} as unknown as GoalCore;
		const scheduler = new GoalScheduler(core);
		scheduler.restore(ctx);
		assert.equal(goal.scheduler!.used, 7);
		assert.equal(goal.scheduler!.owner, matched ? sm.getSessionId() : "old");
		assert.equal(queued, matched ? 1 : 0);
		if (matched) {
			listener!({ sessionId: "unrelated", held: true });
			scheduler.schedule(ctx); assert.equal(queued, 2);
			listener!({ sessionId: sm.getSessionId(), held: true });
			scheduler.schedule(ctx); assert.equal(queued, 2);
			assert.equal(scheduler.claim(ctx), null);
			listener!({ sessionId: sm.getSessionId(), held: false });
			assert.equal(queued, 3);
			assert.equal(goal.scheduler!.used, 7);
		}
		scheduler.shutdown();
	}
});

for (const failure of ["summary", "cancelled"] as const) test(`${failure} failure retains source and stops automatic retries`, async t => {
	const h = fixture(t);
	await h.fire("session_start");
	h.sm.appendMessage(response()); h.sm.appendMessage(response());
	if (failure === "summary") h.fail(); else h.cancel();
	await h.run();
	assert.equal(h.fresh(), undefined);
	assert.equal(providerTurns(h.sm.getEntries()), 2);
	assert.match(h.notices.at(-1)!, /Automatic retries are disabled/);
	await h.fire("agent_settled", { aborted: false });
	assert.deepEqual(h.sent, []);
	assert.ok(h.sm.getBranch().some(e => e.type === "custom" && e.customType === HANDOFF_ENTRY && (e.data as { failed?: boolean }).failed));
});
