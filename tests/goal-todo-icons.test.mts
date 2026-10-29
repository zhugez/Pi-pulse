/**
 * Icon regression test for the goal + todo UI.
 *
 * Every status marker is a Nerd Font glyph (one cell). This test renders the
 * pure renderers at several terminal widths and asserts that
 *   - no old dingbat/block status glyph comes back,
 *   - the only block glyphs left are inside `[███░░]` progress bars,
 *   - no rendered line overflows its width.
 *
 * It also scans the two extensions for bracket checkboxes in UI code, which
 * must stay confined to the allowlisted files (markdown persistence,
 * model-facing prompts, and the legacy-tolerant parser).
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  renderAuditResultCard,
  renderAuditorDashboard,
  renderCompactDashboard,
  renderExpandedDashboard,
} from "../extensions/goal/widgets/goal-dashboard-renderer.ts";
import { buildGoalStatusText, PLAIN_THEME } from "../extensions/goal/goal-status.ts";
import { TASK_MARK, taskMark } from "../extensions/goal/goal-format.ts";
import {
  ACTION_GLYPH,
  STATUS_GLYPH,
  formatCommandTaskLine,
  formatOverlayTaskLine,
} from "../extensions/todo/view/format.ts";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  dim: (value: string) => value,
  strikethrough: (value: string) => value,
} as never;

/** Old vocabulary: dingbats that shipped before the Nerd Font switch. */
const RETIRED_DINGBAT = /[✓✔✗✘▸▹◌●○◐◑■□★☆☑⛽⟡⏸▴▾⊙✎▰▱⊘⛓☰∅›]/;
/** Blocks are still used by the progress bars, never as status markers. */
const BLOCK = /[█▓▒░]/;
const PROGRESS_BAR = /\[[█░]+\]/g;
const NERD_FONT = /[\ue000-\uf8ff]|[\u{f0000}-\u{f1fff}]/u;

// Cover every integer width in the supported test range, including layout boundaries.
const WIDTHS = Array.from({ length: 83 }, (_, i) => i + 38);

function dashboardModel() {
  return {
    scheduling: [],
    goalId: "goal-1",
    title: "Icon regression",
    status: { code: "running", label: "running", footerLabel: "running" },
    focused: true,
    auditorEnabled: true,
    filePath: ".pi/goals/active_goal_test.md",
    usage: { activeSeconds: 61, tokens: 1234, footerBits: "1m 1.2k" },
    budget: { used: 12_000, total: 30_000, percentage: 40, remaining: 18_000 },
    taskProgress: { completed: 1, total: 3, percentage: 33 },
    taskTree: [
      { id: "task-1", title: "Done task", status: "complete", depth: 0, isCurrent: false, totalSubtasks: 0, completedSubtasks: 0, verificationContract: "tsc" },
      { id: "task-2", title: "Current task", status: "pending", depth: 0, isCurrent: true, totalSubtasks: 2, completedSubtasks: 1 },
      { id: "task-3", title: "Skipped task", status: "skipped", depth: 0, isCurrent: false, totalSubtasks: 0, completedSubtasks: 0 },
    ],
    currentTask: { id: "task-2", title: "Current task", depth: 0, completedSubtasks: 1, totalSubtasks: 2, subtaskPercentage: 50 },
    otherOpenGoals: 0,
    recentActivity: [
      { at: "t", kind: "task", text: "done", marker: "done" },
      { at: "t", kind: "task", text: "current", marker: "current" },
      { at: "t", kind: "task", text: "skipped", marker: "skipped" },
      { at: "t", kind: "note", text: "note" },
    ],
  } as never;
}

function auditorModel() {
  return {
    auditorLabel: "provider/model",
    elapsedMs: 61_000,
    percentage: 40,
    active: true,
    recentOutput: [],
    checks: [
      { state: "passed", label: "Contract" },
      { state: "running", label: "Evidence" },
      { state: "pending", label: "Verdict" },
      { state: "failed", label: "Build" },
    ],
  } as never;
}

function goalRecord() {
  return {
    id: "goal-1",
    objective: "Icon regression",
    status: "active",
    autoContinue: true,
    mode: "regular",
    currentTaskId: "task-2",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    usage: { activeSeconds: 61, tokensUsed: 1234 },
    taskList: {
      tasks: [
        { id: "task-1", title: "Done task", status: "complete" },
        { id: "task-2", title: "Current task", status: "pending" },
        { id: "task-3", title: "Skipped task", status: "skipped" },
      ],
    },
  } as never;
}

const todoTask = { id: 2, subject: "Render test", status: "in_progress", activeForm: "rendering", createdAt: "t", updatedAt: "t" } as never;

function surfaces(): Array<{ name: string; width: number; lines: string[] }> {
  const out: Array<{ name: string; width: number; lines: string[] }> = [];
  for (const width of WIDTHS) {
    out.push({ name: `compact@${width}`, width, lines: renderCompactDashboard(dashboardModel(), theme, width) });
    out.push({ name: `expanded@${width}`, width, lines: renderExpandedDashboard(dashboardModel(), theme, width, { rows: 20 }) });
    out.push({ name: `audit@${width}`, width, lines: renderAuditorDashboard(auditorModel(), theme, width) });
    out.push({
      name: `audit-result@${width}`,
      width,
      lines: renderAuditResultCard({ verdict: "approved", label: "ok", lines: ["all good"] } as never, theme, width),
    });
    out.push({ name: `status@${width}`, width, lines: buildGoalStatusText({ goal: goalRecord(), theme: PLAIN_THEME as never, width } as never).split("\n") });
  }
  out.push({
    name: "todo-rows",
    width: 100,
    lines: [
      formatOverlayTaskLine(todoTask, theme, true),
      formatOverlayTaskLine({ ...(todoTask as object), status: "pending" } as never, theme, true),
      formatOverlayTaskLine({ ...(todoTask as object), status: "completed" } as never, theme, true),
      formatCommandTaskLine(todoTask, STATUS_GLYPH.in_progress),
      ...Object.values(ACTION_GLYPH),
    ],
  });
  return out;
}

test("goal and todo surfaces use Nerd Font markers only", () => {
  let nerdLines = 0;
  for (const { name, width, lines } of surfaces()) {
    for (const line of lines) {
      const withoutBars = line.replace(PROGRESS_BAR, "");
      assert.ok(!RETIRED_DINGBAT.test(withoutBars), `${name}: retired dingbat in ${JSON.stringify(line)}`);
      assert.ok(!BLOCK.test(withoutBars), `${name}: block glyph outside a progress bar in ${JSON.stringify(line)}`);
      assert.ok(visibleWidth(line) <= width, `${name}: line is ${visibleWidth(line)} cells, width is ${width}`);
      if (NERD_FONT.test(line)) nerdLines += 1;
    }
  }
  assert.ok(nerdLines > 0, "expected Nerd Font markers somewhere in the rendered output");
});

test("status and action glyph sets are Nerd Font, one cell each", () => {
  assert.deepEqual(STATUS_GLYPH, { pending: "", in_progress: "", completed: "", deleted: "" });
  assert.deepEqual(TASK_MARK, { pending: "", complete: "", skipped: "" });
  for (const status of ["pending", "complete", "skipped"] as const) {
    assert.equal(taskMark(status), TASK_MARK[status]);
  }
  for (const glyph of [...Object.values(STATUS_GLYPH), ...Object.values(TASK_MARK), ...Object.values(ACTION_GLYPH)]) {
    assert.match(glyph, NERD_FONT, `expected a Nerd Font glyph, got ${JSON.stringify(glyph)}`);
    assert.equal(visibleWidth(glyph), 1, `${JSON.stringify(glyph)} must measure one cell`);
  }
});

// ── source scan: bracket checkboxes must not come back into UI code ─────────

const ROOTS = ["extensions/goal", "extensions/todo"];
/** Files where `[x]`/`[ ]` is intentional: markdown persistence, model-facing
 *  prompts, the legacy-tolerant parser, and comments describing the format. */
const ALLOWED = new Set([
  "extensions/goal/storage/goal-files.ts",
  "extensions/goal/prompts/goal-prompts.ts",
  "extensions/goal/goal-auditor.ts",
  "extensions/goal/goal-questionnaire.ts",
  "extensions/goal/goal-task-derive.ts",
]);

function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, acc);
    else if (full.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

test("bracket checkboxes stay out of goal and todo UI code", () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of sources(root)) {
      if (ALLOWED.has(file)) continue;
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comment line
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
        if (/\[[ x~]\]/.test(code)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `bracket checkboxes found in UI code:\n${offenders.join("\n")}`);
});
