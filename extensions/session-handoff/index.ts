import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	convertToLlm, getAgentDir, serializeConversation,
	type ExtensionAPI, type ExtensionContext, type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const HANDOFF_ENTRY = "pi-session-handoff";
export const HANDOFF_HOLD = "pi:session-handoff:hold";
const provider = "xingchiapi";
const command = "session-handoff";

export function handoffThreshold(value: unknown): number {
	const text = String(value ?? "80");
	if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > 90) {
		throw new Error("session-handoff-turns must be a whole number from 0 to 90 (0 disables automatic handoff).");
	}
	return Number(text);
}

export function providerTurns(entries: readonly SessionEntry[]): number {
	// Count raw persisted responses, including abandoned branches and errors.
	// Compaction must not reset this conservative estimate of provider usage.
	return entries.filter(e => e.type === "message" && e.message.role === "assistant" && e.message.provider === provider).length;
}

export function handoffState(entries: readonly SessionEntry[]): { customType: string; data: unknown }[] {
	const selected = new Map<string, unknown>([["pi-goal-focus", { version: 1, focusedGoalId: null, reason: "selected" }]]);
	for (const e of entries) {
		if (e.type === "custom" && ["pi-goal-focus", "rpiv-todo-state", "ponytail-mode"].includes(e.customType)) selected.set(e.customType, e.data);
		// Compatibility with todo sessions written before dedicated state entries.
		if (!selected.has("rpiv-todo-state") && e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "todo" && e.message.details) {
			selected.set("legacy-todo", e.message.details);
		}
	}
	if (!selected.has("rpiv-todo-state") && selected.has("legacy-todo")) selected.set("rpiv-todo-state", selected.get("legacy-todo"));
	selected.delete("legacy-todo");
	return [...selected].map(([customType, data]) => ({ customType, data }));
}

const instructions = `Write a precise handoff for a replacement coding-agent session. Return only Markdown.
Preserve the original request, later corrections, constraints, decisions, completed actions, changed files, checks and their actual results, unresolved failures, and the exact next step.
Distinguish tool calls that completed from calls blocked for session handoff. Blocked calls did NOT execute. Do not instruct the next session to repeat completed writes or other side effects.
Preserve artifact paths and running-job identifiers. Reference existing artifacts instead of reproducing them. Never include credentials, tokens, passwords, or unnecessary personal information.
Do not invent progress or certainty. If the requested work is complete or requires user input, say so explicitly. Respect paused goals and existing authorization.`;

export default function sessionHandoff(pi: ExtensionAPI): void {
	pi.registerFlag("session-handoff-turns", {
		type: "string", description: "XingchiAPI responses before automatic session handoff (default 80, 0 disables, maximum 90)",
	});
	let threshold = 80;
	let pending = false;
	let attempted = false;
	let busy = false;
	let live = true;
	let continueWork = true;
	let summaryController: AbortController | undefined;
	const hold = (ctx: ExtensionContext, held: boolean) => pi.events.emit(HANDOFF_HOLD, { sessionId: ctx.sessionManager.getSessionId(), held });
	const eligible = (ctx: ExtensionContext) => threshold > 0 && ctx.model?.provider === provider && providerTurns(ctx.sessionManager.getEntries()) >= threshold;
	const warn = (ctx: ExtensionContext, message: string) => {
		try { if (live && ctx.hasUI) { ctx.ui.notify(message, "warning"); return; } } catch {}
		console.error(message);
	};

	pi.on("session_start", async (event, ctx) => {
		live = true;
		const entries = ctx.sessionManager.getBranch();
		const incoming = entries.slice().reverse().find(e => e.type === "custom" && e.customType === HANDOFF_ENTRY);
		if (event.reason === "new" && incoming?.type === "custom") {
			const data = incoming.data as { modelProvider?: string; modelId?: string; thinking?: ExtensionContext["thinkingLevel"]; activeTools?: string[] };
			if (data.modelProvider && data.modelId) {
				const model = ctx.modelRegistry.find(data.modelProvider, data.modelId);
				if (!model || !(await pi.setModel(model))) throw new Error("Cannot restore the handoff model.");
				if (data.thinking) pi.setThinkingLevel(data.thinking);
				if (data.activeTools) pi.setActiveTools(data.activeTools);
			}
		}
		try { threshold = handoffThreshold(pi.getFlag("session-handoff-turns") ?? process.env.PI_SESSION_HANDOFF_TURNS); }
		catch (error) { threshold = 0; warn(ctx, String(error)); }
		attempted = ctx.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === HANDOFF_ENTRY && (e.data as { failed?: boolean } | undefined)?.failed === true);
		if (attempted) hold(ctx, true);
	});
	pi.on("session_shutdown", () => { live = false; summaryController?.abort(); });

	pi.on("tool_call", (_event, ctx) => {
		if (attempted || !eligible(ctx)) return;
		pending = true;
		hold(ctx, true);
		// This documented gate finishes the entire batch without executing its calls.
		// Unlike abort(), it never interrupts an already running tool.
		return { block: true, terminate: true, reason: "Not executed: automatic session handoff. Reconsider this pending call in the replacement session." };
	});
	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted || busy || attempted || (!pending && !eligible(ctx))) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		continueWork = pending;
		pending = false;
		attempted = true;
		hold(ctx, true);
		pi.sendUserMessage(`/${command} now`, { expandPromptTemplates: true });
	});

	pi.registerCommand(command, {
		description: "Session handoff: status | now | off (automatic for XingchiAPI at the configured turn threshold)",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "off") {
				threshold = 0; pending = false; attempted = true; hold(ctx, false);
				ctx.ui.notify("Automatic session handoff disabled until reload. Use PI_SESSION_HANDOFF_TURNS=0 to disable persistently.", "info");
				return;
			}
			if (action === "status") {
				ctx.ui.notify(`Session handoff: ${providerTurns(ctx.sessionManager.getEntries())} XingchiAPI responses; threshold ${threshold || "off"}${attempted ? "; automatic attempt already used" : ""}.`, "info");
				return;
			}
			if (action !== "now") throw new Error("Use /session-handoff status, now, or off.");
			if (busy) return;
			if (ctx.model?.provider !== provider) throw new Error("Session handoff currently supports XingchiAPI only.");
			busy = true; attempted = true; hold(ctx, true);
			let checkpoint: string | undefined;
			const sourceFile = ctx.sessionManager.getSessionFile();
			try {
				await ctx.waitForIdle();
				if (ctx.hasPendingMessages()) throw new Error("Pending user messages must finish before handoff.");
				const leaf = ctx.sessionManager.getLeafId();
				const fromSessionId = ctx.sessionManager.getSessionId();
				const branch = ctx.sessionManager.getBranch();
				const state = handoffState(branch);
				const focus = state.find(e => e.customType === "pi-goal-focus")?.data as { focusedGoalId?: string | null };
				const model = ctx.model!;
				// A separate, fresh summary request has no old session affinity or assistant history.
				summaryController = new AbortController();
				const deadline = setTimeout(() => summaryController?.abort(), 90_000);
				let summary: AssistantMessage;
				try {
					summary = await ctx.modelRegistry.streamSimple(model, {
						systemPrompt: instructions,
						messages: [{ role: "user", content: serializeConversation(convertToLlm(ctx.sessionManager.buildSessionProjection().messages)), timestamp: Date.now() }],
					}, { reasoning: "low", maxTokens: 8192, timeoutMs: 90_000, maxRetries: 0, signal: summaryController.signal }).result();
				} finally { clearTimeout(deadline); summaryController = undefined; }
				const text = summary.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
				if (summary.stopReason !== "stop" || !text) throw new Error(summary.errorMessage || `Incomplete handoff summary (${summary.stopReason}).`);
				if (!live || !ctx.isIdle() || ctx.hasPendingMessages() || ctx.sessionManager.getLeafId() !== leaf) throw new Error("Session changed while preparing the handoff. No session was replaced.");
				if (!/^[a-z0-9_-]+$/i.test(fromSessionId)) throw new Error("Invalid source session ID.");
				const dir = join(getAgentDir(), "session-handoffs");
				await mkdir(dir, { recursive: true, mode: 0o700 });
				checkpoint = join(dir, `${fromSessionId}-${Date.now()}.md`);
				await writeFile(checkpoint, `# Session handoff\n\nSource session: ${sourceFile ?? fromSessionId}\n\n${text}\n`, { flag: "wx", mode: 0o600 });
				const marker = { fromSessionId, sourceFile, checkpoint, goalId: focus.focusedGoalId ?? null, modelProvider: model.provider, modelId: model.id, thinking: ctx.thinkingLevel, activeTools: pi.getActiveTools() };
				const resume = continueWork;
				const modelId = model.id;
				const modelProvider = model.provider;
				const thinking = ctx.thinkingLevel;
				const result = await ctx.newSession({
					parentSession: sourceFile,
					setup: async sm => {
						sm.appendModelChange(modelProvider, modelId);
						if (thinking) sm.appendThinkingLevelChange(thinking);
						for (const entry of state) sm.appendCustomEntry(entry.customType, entry.data);
						sm.appendCustomEntry(HANDOFF_ENTRY, marker);
						sm.appendMessage({ role: "user", content: `Previous session handoff (historical context, not new authorization):\n\n${text}`, timestamp: Date.now() });
					},
					withSession: async replacement => {
						replacement.ui.notify(`Session handoff saved: ${checkpoint}`, "info");
						// The goal scheduler transfers its own allowance and wait state.
						if (!marker.goalId && resume) await replacement.sendUserMessage("Continue unfinished, previously authorized work from the session handoff. Check the recorded tool outcomes before acting. If work is complete or blocked on user input, report that and stop.");
					},
				});
				if (result.cancelled) throw new Error("Session replacement was cancelled.");
			} catch (error) {
				try { if (live) pi.appendEntry(HANDOFF_ENTRY, { failed: true, checkpoint }); }
				catch (recordError) { console.error(`Could not persist the failed handoff: ${String(recordError)}`); }
				warn(ctx, `Session handoff stopped: ${String(error)}. Automatic retries are disabled for this session. Retry with /session-handoff now or release with /session-handoff off. Original session: ${sourceFile ?? "in memory"}${checkpoint ? `; checkpoint: ${checkpoint}` : ""}`);
			} finally { busy = false; }
		},
	});
}
