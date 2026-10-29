import { GOAL_KEY_ACTIONS, GOAL_COMMAND_INPUTS, bindingKeys, keyActionBinding, type GoalCommandId } from "./goal-controls.ts";
import { matchesKey, getKeybindings } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cloneGoal, createGoal, nowIso, type GoalTask } from "./goal-record.ts";
import { checkSubtasksComplete, findTaskInTree } from "./goal-policy.ts";
import { loadGoalSettings } from "./goal-settings.ts";
import { serializeGoalFile } from "./storage/goal-files.ts";
import type { AuditorWidgetProgress } from "./widgets/goal-widget.ts";
import type { GoalCore } from "./goal-state.ts";

const DEBUG_GOALS_DIR = ".pi/goals/debug";
const KEY_ACTION_BY_PATH = new Map(GOAL_KEY_ACTIONS.map(action => [action.path.slice(1).join("."), action]));
const COMMAND_KEYS = GOAL_KEY_ACTIONS.filter(action => action.path[1] === "commands");
const EXPANDED_NAVIGATION = [["up", "up"], ["down", "down"], ["pageUp", "pageUp"], ["pageDown", "pageDown"], ["first", "home"], ["last", "end"]] as const;
const COMPACT_NAVIGATION = [["scrollUp", "up"], ["scrollDown", "down"], ["scrollPageUp", "pageUp"], ["scrollPageDown", "pageDown"], ["scrollFirst", "home"], ["scrollLast", "end"]] as const;


function isKittyRepeatOrRelease(data: string): boolean {
	return data.startsWith("\x1b[") && /^[0-9:;]+:[23][u~ABCDHF]$/.test(data.slice(2));
}

/**
 * Terminal input keybindings (Escape pause/abort-audit, Ctrl+Shift+T dashboard
 * overlay, and the hidden debug-mode bindings) plus the debug goal/task/audit
 * helpers. Re-registered at session start/tree navigation; the handler reads
 * live state through the core at event time.
 */
let debugGoalCounter = 0;
let debugMockAuditTimer: ReturnType<typeof setInterval> | null = null;

/** Debug helpers are inert unless PI_GOAL_DEBUG is set (P1-13). */
function isDebugEnabled(): boolean {
	const value = process.env.PI_GOAL_DEBUG;
	return value === "true" || value === "1";
}

/** Render task lines for the debug proposal dialog. */
function formatModeLabelDebug(sisyphus: boolean): string {
	return sisyphus ? "Sisyphus (prompt/criteria style)" : "Normal goal";
}

function formatPrefixedLinesDebug(content: string): string[] {
	const lines: string[] = [];
	for (const rawLine of content.split("\n")) {
const trimmed = rawLine.trim();
if (!trimmed) continue;
if (trimmed.startsWith("│")) {
	lines.push(rawLine);
} else {
	lines.push(`│   ${rawLine}`);
}
	}
	return lines;
}

function formatSectionDebug(title: string, content: string): string[] {
	const body = formatPrefixedLinesDebug(content);
	return ["", `─── ${title} ───`, "", ...body];
}


/**
 * F3: toggle one task through the goal-service mutation boundary with the
 * same gates as update_goal_task: completing a pending task requires its
 * subtasks complete first and (unless contracts are disabled) evidence when
 * it carries a verification contract — the evidence is collected through the
 * UI input dialog; completing a complete task reopens it to pending (a
 * deliberate TUI-only relaxation of the tool surface's immutability, for
 * explicit human corrections).
 */
export async function toggleTaskViaService(core: GoalCore, ctx: ExtensionContext, goalId: string, taskId: string): Promise<{ ok: boolean; message?: string }> {
	const goal = core.goalsById.get(goalId);
	if (!goal) return { ok: false, message: `Goal ${goalId} not found in this session.` };
	if (goal.status !== "active") return { ok: false, message: `Task updates apply only to an active goal (current status: ${goal.status}).` };
	if (!goal.taskList) return { ok: false, message: "The goal has no task list." };
	const settings = loadGoalSettings(ctx.cwd);
	const task = findTaskInTree(goal.taskList.tasks, taskId);
	if (!task) return { ok: false, message: `Task "${taskId}" not found.` };
	const now = nowIso();

	if (task.status === "pending") {
		let evidence: string | undefined;
		if (!settings.disableContracts && task.verificationContract) {
			const input = await ctx.ui.input(`Evidence for task ${taskId}`, "");
			if (input === undefined || !input.trim()) {
				return { ok: false, message: `Task "${taskId}" has a verification contract; provide evidence to complete it.` };
			}
			evidence = input.trim().slice(0, 200);
		}
		const subtaskGate = checkSubtasksComplete(task);
		if (subtaskGate) return { ok: false, message: subtaskGate };
		const result = core.goalService.updateTask(ctx, {
			focusToken: core.focusedOperationToken(goalId),
			taskId,
			validate: (t) => {
				if (t.status === "complete") return { ok: false, message: `Task "${taskId}" is already complete.` };
				return { ok: true };
			},
			update: (t) => ({ ...t, status: "complete" as const, completedAt: now, evidence }),
			ledger: (written) => [{ type: "task_complete", goalId: written.id, taskId, evidence, at: written.updatedAt }],
		});
		if (!result.ok) return { ok: false, message: result.message };
		return { ok: true };
	}

	if (task.status === "complete") {
		const result = core.goalService.updateTask(ctx, {
			focusToken: core.focusedOperationToken(goalId),
			taskId,
			validate: () => ({ ok: true }),
			update: (t) => ({ ...t, status: "pending" as const, completedAt: undefined, evidence: undefined }),
			ledger: (written) => [{ type: "task_reopened", goalId: written.id, taskId, at: written.updatedAt }],
		});
		if (!result.ok) return { ok: false, message: result.message };
		return { ok: true };
	}

	return { ok: false, message: `Task "${taskId}" is skipped; change it with /goal-tweak or update_goal_task.` };
}

export function syncTerminalInputPause(core: GoalCore, ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		core.terminalInputUnsubscribe?.();
		const goalCwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
		core.terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			// The active dialog owns every key, including key capture and Escape.
			if (core.goalModalDepth > 0) return undefined;
			if (core.goalWidgetComponentRef.current?.isMainEditorFocused?.() === false) return undefined;
			const settings = loadGoalSettings(goalCwd);
			const matches = (path: string): boolean => {
				const action = KEY_ACTION_BY_PATH.get(path)!;
				return bindingKeys(keyActionBinding(settings, action)).some(key => matchesKey(data, key));
			};
			if (isKittyRepeatOrRelease(data)) {
				const applicable = GOAL_KEY_ACTIONS.filter(action => action.context === "global" ||
					(core.auditProgress ? action.context === "audit" : core.isDashboardExpanded() ? action.context === "expanded" : action.context === "compact"));
				return applicable.some(action => bindingKeys(keyActionBinding(settings, action)).some(key => matchesKey(data, key))) ? { consume: true } : undefined;
			}
			if (core.auditProgress && matches("interruptAudit")) { core.abortAudit(ctx); return { consume: true }; }
			if (core.isDashboardExpanded() && matches("dashboard.collapse")) { core.toggleDashboardExpanded(); return { consume: true }; }
			if (matches("pause") && ((core.state.goal?.status === "active" && core.state.goal.autoContinue) || (core.state.goal?.status === "paused" && !ctx.isIdle()))) {
				core.interruption.pause(ctx);
				// Preserve Pi's ordinary Escape handling for the default combined stop.
				return matchesKey(data, "escape") && settings.pauseOrder === "together" ? undefined : { consume: true };
			}
			// Follow Pi's configured interrupt key.
			let hostInterrupt = matchesKey(data, "escape");
			try {
				const manager = getKeybindings();
				const keys = manager.getKeys("app.interrupt");
				if (keys.length) hostInterrupt = keys.some(key => matchesKey(data, key));
			} catch { /* Embeddings without an app keymap retain Escape. */ }
			if (hostInterrupt && !matches("pause") && core.state.goal?.status === "active" && core.state.goal.autoContinue) {
				core.interruption.interruptTurn(ctx); return { consume: true };
			}
			if (matches("dashboard.toggleExpand")) { core.toggleDashboardExpanded(); return { consume: true }; }
			if (matches("toggleAuditor")) {
				core.toggleGoalAuditor(ctx); core.goalWidgetComponentRef.current?.invalidate(); return { consume: true };
			}
			if (core.isDashboardExpanded()) {
				for (const [name, key] of EXPANDED_NAVIGATION) if (matches(`dashboard.${name}`) && core.goalWidgetComponentRef.current?.handleNavigationKey(key)) return { consume: true };
			} else {
				for (const [name, key] of COMPACT_NAVIGATION) if (matches(`dashboard.${name}`) && core.goalWidgetComponentRef.current?.handleCompactScrollKey(key)) return { consume: true };
			}
			for (const action of COMMAND_KEYS) {
				if (!bindingKeys(keyActionBinding(settings, action)).some(key => matchesKey(data, key))) continue;
				const id = action.path[2] as GoalCommandId;
				const revision = core.focusRevision;
				const owner = core.sessionOwner;
				void (async () => {
					core.enterGoalModal();
					try {
						const prompt = GOAL_COMMAND_INPUTS[id];
						const args = prompt ? await ctx.ui.input(prompt) : "";
						if (core.focusRevision !== revision || args === undefined || (prompt && !args.trim())) return;
						await core.invokeGoalCommand?.(id, args, ctx);
					} finally { if (core.sessionOwner === owner) core.exitGoalModal(); }
				})().catch(error => {if (core.sessionOwner === owner) ctx.ui.notify(String(error), "error");});
				return { consume: true };
			}

			// Debug keybindings are inert unless PI_GOAL_DEBUG is set (P1-13).
			if (!isDebugEnabled()) return undefined;

			// ── Debug mode keybindings (hidden from normal view) ────────────────

			// Ctrl+Shift+X — toggle debug mode on/off
			if (matchesKey(data, "ctrl+shift+x")) {
				core.debugMode = !core.debugMode;
				ctx.ui.notify(core.debugMode ? "Debug mode ON" : "Debug mode OFF", "info");
				core.goalWidgetComponentRef.current?.invalidate();
				return { consume: true };
			}

			// Only process the following debug keybindings when debug mode is active
			if (!core.debugMode) return undefined;

			// Ctrl+Shift+N — create a test goal
			if (matchesKey(data, "ctrl+shift+n")) {
				createDebugGoal(ctx);
				return { consume: true };
			}

			// Ctrl+Shift+T — inject sample tasks into current goal
			if (matchesKey(data, "ctrl+shift+t")) {
				injectDebugTasks(ctx);
				return { consume: true };
			}

			// Ctrl+Shift+R — start mock completion audit
			if (matchesKey(data, "ctrl+shift+r")) {
				startMockAudit(ctx);
				return { consume: true };
			}

			// Ctrl+Shift+O — open proposal dialog with sample data
			if (matchesKey(data, "ctrl+shift+o")) {
				openDebugProposal(ctx);
				return { consume: true };
			}

			return undefined;
		});

		/** Toggle a test goal: create (first press) or remove (second press) */
		function createDebugGoal(ctx: ExtensionContext): void {
			if (!isDebugEnabled()) return;
			const prev = core.state.goal;
			if (prev && prev.id.startsWith("debug-")) {
				// Toggle off — remove debug goal entirely (no archive, full delete)
				const filePath = `${DEBUG_GOALS_DIR}/debug_goal.md`;
				core.goalService.removeDebugFile(ctx, filePath);
				const prevId = prev.id;
				core.state.goal = null;
				if (core.focusedGoalId === prevId) {
					core.goalsById.delete(prevId);
					core.assignFocusedGoalId(null);
				}
				core.clearStoppedRuntimeState();
				core.updateUI(ctx);
				ctx.ui.notify("Debug goal removed", "info");
				return;
			}

			// Toggle on — create a new debug goal, write to temp dir
			debugGoalCounter++;
			const goal = createGoal({
				objective: "=== Goal ===\nObjective: Debug test goal",
				autoContinue: true,
				sisyphus: false,
			});
			goal.id = `debug-${nowIso().replace(/[:.]/g, "-")}-${debugGoalCounter}`;
			goal.createdAt = nowIso();
			goal.updatedAt = nowIso();
			goal.activePath = `${DEBUG_GOALS_DIR}/debug_goal.md`;
			core.goalService.writeDebugFile(ctx, goal.activePath, serializeGoalFile(goal));
			core.setGoal(goal, ctx, false, "created"); // no persist (we already wrote the file)
			ctx.ui.notify(`Debug goal created: ${goal.id}`, "info");
		}

		/** Inject 3-4 sample tasks into the current goal */
		function injectDebugTasks(ctx: ExtensionContext): void {
			if (!isDebugEnabled()) return;
			if (!core.state.goal) {
				ctx.ui.notify("No goal to inject tasks into; create one first (Ctrl+Shift+N)", "warning");
				return;
			}
			const now = nowIso();
			const tasks: GoalTask[] = [
				{
					id: "t1",
					title: "Set up project structure",
					status: "complete",
					completedAt: now,
					subtasks: [
						{ id: "t1a", title: "Initialize repo", status: "complete", completedAt: now },
						{ id: "t1b", title: "Add build config", status: "pending" },
					],
				},
				{
					id: "t2",
					title: "Implement core feature",
					status: "pending",
				},
				{
					id: "t3",
					title: "Write tests",
					status: "pending",
				},
			];
			const next = cloneGoal(core.state.goal);
			next.taskList = { tasks, blockCompletion: false, proposedAt: now };
			next.updatedAt = now;
			core.setGoal(next, ctx);
			ctx.ui.notify("Sample tasks injected (3 tasks, 1 completed)", "info");
		}

		/** Stop mock audit timer if running */
		function stopMockAuditTimer(): void {
			if (debugMockAuditTimer) {
				clearInterval(debugMockAuditTimer);
				debugMockAuditTimer = null;
			}
		}

		/** Start a mock completion audit that transitions through phases */
		function startMockAudit(ctx: ExtensionContext): void {
			if (!isDebugEnabled()) return;
			stopMockAuditTimer();
			const startedAt = Date.now();
			const phases: { phase: AuditorWidgetProgress["phase"]; atMs: number; label: string; percentage: number }[] = [
				{ phase: "tool_executing", atMs: 0, label: "Checking test results...", percentage: 10 },
				{ phase: "tool_executing", atMs: 800, label: "Verifying requirements...", percentage: 30 },
				{ phase: "thinking", atMs: 1800, label: "Evaluating completion criteria...", percentage: 60 },
				{ phase: "producing_report", atMs: 3200, label: "Writing audit report...", percentage: 85 },
				{ phase: "done", atMs: 4800, label: "Audit complete", percentage: 100 },
			];
			core.auditProgress = {
				recentOutput: [],
				phase: "running",
				elapsedMs: 0,
			};
			core.goalWidgetComponentRef.current?.invalidate();

			debugMockAuditTimer = setInterval(() => {
				const elapsed = Date.now() - startedAt;
				let currentPhase: AuditorWidgetProgress["phase"] = "done";
				let currentLabel = "Audit complete";
				let currentPct = 100;
				for (let i = phases.length - 1; i >= 0; i--) {
					if (elapsed >= phases[i]!.atMs) {
						currentPhase = phases[i]!.phase;
						currentLabel = phases[i]!.label;
						currentPct = phases[i]!.percentage;
						break;
					}
				}
				core.auditProgress = {
					phase: currentPhase,
					label: currentLabel,
					percentage: currentPct,
					elapsedMs: elapsed,
					recentOutput: core.auditProgress?.recentOutput ?? [],
				};
				if (currentPhase === "done") {
					if (core.auditProgress) core.auditProgress.recentOutput = [
						"✓ All requirements verified",
						"✓ Tests pass: 310/310",
						"✓ No truncation cap remaining",
					];
					stopMockAuditTimer();
					// Auto-clear audit after 3 more seconds
					setTimeout(() => {
						core.auditProgress = null;
						core.goalWidgetComponentRef.current?.invalidate();
					}, 3000);
				}
				core.goalWidgetComponentRef.current?.invalidate();
			}, 100);
			debugMockAuditTimer.unref?.();
		}

function renderDebugTaskLines(tasks: GoalTask[], indent = 0): string[] {
			const prefix = "  ".repeat(indent);
			const lines: string[] = [];
			for (const t of tasks) {
				const marker = t.status === "complete" ? "[x]" : t.status === "skipped" ? "[~]" : "[ ]";
				const lw = t.lightweightSubtasks ? " (lightweight)" : "";
				lines.push(`${prefix}${marker} ${t.id}: ${t.title}${lw}`);
				if (t.subtasks && t.subtasks.length > 0) {
					lines.push(...renderDebugTaskLines(t.subtasks, indent + 1));
				}
			}
			return lines;
		}

		/** Show the proposal dialog using real goal state — no hardcoded text */
		function openDebugProposal(ctx: ExtensionContext): void {
			if (!isDebugEnabled()) return;
			// Build a fresh debug goal + tasks in memory for the dialog
			debugGoalCounter++;
			const goal = createGoal({
				objective: `=== Goal ===
Objective: Add collapsible task sections to the goal widget so large task lists are navigable

Success criteria:
- Tasks are grouped into sections by status (pending, active, complete) with visible section headers
- Each section header is toggleable — clicking it expands or collapses that section
- When collapsed, the section shows a header line only with a task count badge
- When expanded, tasks render with normal indentation and per-line styling
- Default state: pending section expanded, active and complete sections collapsed
- Section state is tracked per-render (no persistence needed)
- All 310 existing tests still pass

Boundaries:
- In scope: GoalWidgetComponent.render() grouping logic, section header toggling, expand/collapse state per render cycle
- Out of scope: task reordering, drag-and-drop, keyboard navigation for sections, persistence of section state across pi restarts
- Out of scope: modifying GoalTask or GoalRecord types

Constraints:
- Render width must respect the existing width parameter — no hardcoded widths
- Section collapse state is a render-only map, not stored in goal record
- Collapse toggle must be keyboard-accessible via existing widget interaction model
- Do not change the GoalWidgetComponent public API (constructor options, render signature)
- Section headers must use theme.fg("accent", ...) consistent with existing render patterns

Verification contract:
- Run npm test and confirm 310/310 pass (0 failures)
- Read render method and confirm task grouping logic exists
- Read expand/collapse toggle handler and confirm it inverts section state
- Confirm collapsed sections only render the header line with task count
- Confirm expanded sections render tasks with correct indentation and styling`,
				autoContinue: true,
				sisyphus: false,
			});
			goal.id = `debug-${nowIso().replace(/[:.]/g, "-")}-${debugGoalCounter}`;
			goal.createdAt = nowIso();
			goal.updatedAt = nowIso();

			const now = nowIso();
			const tasks: GoalTask[] = [
				{
					id: "t1",
					title: "Set up project structure",
					status: "complete",
					completedAt: now,
					subtasks: [
						{ id: "t1a", title: "Initialize repo", status: "complete", completedAt: now },
						{ id: "t1b", title: "Add build config", status: "pending" },
					],
				},
				{
					id: "t2",
					title: "Implement core feature",
					status: "pending",
					subtasks: [
						{ id: "t2a", title: "Status grouping logic", status: "pending" },
						{ id: "t2b", title: "Section header component", status: "pending" },
						{ id: "t2c", title: "Expand/collapse state", status: "pending" },
						{ id: "t2d", title: "Task count badge", status: "pending" },
					],
				},
				{ id: "t3", title: "Update tests", status: "pending" },
				{ id: "t4", title: "Manual TUI verification", status: "pending" },
			];
			goal.taskList = { tasks, blockCompletion: false, proposedAt: now };
			// Development-only diagnostic: the legacy proposal dialog is
			// gone; the injected sample task list is inspected through the goal
			// file and the debug task overlay (Ctrl+Shift+T).
			ctx.ui.notify(
				`Injected sample task list into debug goal ${goal.id}; inspect the goal file or use the debug task overlay.`,
				"info",
			);
		}
}
