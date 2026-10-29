import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ExtensionContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { Text, visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui';

import { buildDraftConfirmationText, buildTweakConfirmationText } from '../extensions/goal/goal-draft.ts';
import { buildGoalTaskDetailBlock } from '../extensions/goal/goal-format.ts';
import { buildGoalCreatedReport } from '../extensions/goal/goal-policy.ts';
import { runGoalQuestionnaire } from '../extensions/goal/goal-questionnaire.ts';
import type { GoalRecord } from '../extensions/goal/goal-record.ts';
import type { GoalCore } from '../extensions/goal/goal-state.ts';
import { renderConfirmationTasks, showTaskConfirmation } from '../extensions/goal/goal-task-confirmation.ts';
import { GoalControlsDialog } from '../extensions/goal/widgets/goal-controls-dialog.ts';
import { showEscapeDialog } from '../extensions/goal/widgets/goal-escape-dialog.ts';
import { buildGoalRunningNotification } from '../extensions/goal/widgets/goal-notifications.ts';
import { showTaskListOverlay } from '../extensions/goal/widgets/task-list-overlay.ts';
// Todo's config dependency ships TypeScript; use Pi's own loader for this branch.
const { createJiti } = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('jiti');
const loadTodo = createJiti(import.meta.url);
const { TodoOverlay } = (await loadTodo.import(
  new URL('../extensions/todo/todo-overlay.js', import.meta.url).href,
)) as typeof import('../extensions/todo/todo-overlay.ts');
const { __resetState, replaceState, setActiveRenderSession } = (await loadTodo.import(
  new URL('../extensions/todo/state/store.js', import.meta.url).href,
)) as typeof import('../extensions/todo/state/store.ts');
import type { Task } from '../extensions/todo/tool/types.ts';
import {
  formatCommandTaskLine,
  formatOverlayTaskLine,
  renderTodoCall,
  renderTodoResult,
} from '../extensions/todo/view/format.ts';

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  strikethrough: (value: string) => value,
} as Theme;
const WIDTHS = Array.from({ length: 83 }, (_, i) => i + 38);
const OLD = /[✓✔✗✘▸▹◌●○◐◑■□★☆☑⛽⟡⏸▴▾⊙✎▰▱⊘⛓☰∅›▓▒]|\[[ x~]\]/;
const goal: GoalRecord = {
  id: 'icon-goal',
  objective: 'Kiểm tra icon 中文 e\u0301',
  status: 'active',
  autoContinue: true,
  sisyphus: false,
  usage: { activeSeconds: 1, tokensUsed: 2 },
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  taskList: {
    blockCompletion: true,
    proposedAt: new Date(0).toISOString(),
    tasks: [
      { id: 'done', title: 'Finished', status: 'complete', evidence: 'verified' },
      { id: 'skip', title: 'Skipped', status: 'skipped' },
      { id: 'next', title: 'Tiếp theo 中文 e\u0301 '.repeat(4), status: 'pending', verificationContract: 'run tests' },
    ],
  },
};
const tasks: Task[] = [
  { id: 1, subject: 'Finished', status: 'completed' },
  { id: 2, subject: 'Current', status: 'in_progress', blockedBy: [1], activeForm: 'rendering' },
  { id: 3, subject: 'Tiếp theo 中文 e\u0301 '.repeat(5), status: 'pending' },
];

function checkLines(name: string, lines: string[], width: number): void {
  assert.ok(lines.length, `${name}: component must render`);
  for (const line of lines) {
    assert.doesNotMatch(line, OLD, `${name}: retired marker in ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(line) <= width, `${name}@${width}: ${visibleWidth(line)} cells: ${JSON.stringify(line)}`);
  }
}
function checkWidths(name: string, component: Component): void {
  for (const width of WIDTHS) {
    component.invalidate();
    checkLines(name, component.render(width), width);
  }
}

type DisposableComponent = Component & { dispose?(): void };
/** Exercise the real component factories without mutating a live Pi session. */
async function capture(
  open: (ctx: ExtensionContext) => Promise<unknown>,
  inspect: (component: DisposableComponent) => void,
): Promise<void> {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'pi-icon-dialog-'));
  let called = false;
  const tui = {
    terminal: { rows: 160, columns: 120 },
    previousLines: [],
    getShowHardwareCursor: () => false,
    setShowHardwareCursor: () => {},
    requestRender: () => {},
  } as unknown as TUI;
  const keymap = { matches: () => false } as unknown as KeybindingsManager;
  const ctx = {
    cwd,
    hasUI: true,
    mode: 'tui',
    ui: {
      theme,
      setWorkingVisible: () => {},
      custom: async (
        factory: (
          t: TUI,
          th: Theme,
          kb: KeybindingsManager,
          done: () => void,
        ) => DisposableComponent | Promise<DisposableComponent>,
      ) => {
        called = true;
        const component = await factory(tui, theme, keymap, () => {});
        try {
          inspect(component);
        } finally {
          component.dispose?.();
        }
        return { decision: 'cancel', cancelled: true, questions: [], answers: [] };
      },
    },
  } as unknown as ExtensionContext;
  try {
    await open(ctx);
    assert.ok(called, 'must exercise ctx.ui.custom, not the headless fallback');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('questionnaire converts legacy checkbox markers and survives terminal resize', async () => {
  await capture(
    (ctx) =>
      runGoalQuestionnaire(
        ctx,
        [
          {
            id: 'confirm',
            question: 'Confirm icons',
            context: '│   [x] done: Finished\n│   [~] skip: Skipped\n[ ] next: Pending',
            options: ['Confirm', 'Continue chatting'],
            recommended: 0,
            allowCustom: false,
          },
          { id: 'second', question: 'Second tab', options: ['OK'], allowCustom: false },
        ],
        { defaultEnabled: true },
      ),
    (component) => {
      const wide = component.render(120).join('\n');
      assert.match(wide, /.*done/);
      assert.match(wide, /.*skip/);
      assert.match(wide, /.*next/);
      // Deliberately resize without invalidate: the host can supply a new width directly.
      checkLines('questionnaire-resize', component.render(38), 38);
      checkWidths('questionnaire', component);
      component.handleInput?.('a');
      assert.match(component.render(80).join('\n'), /.*Auditor disabled/);
      component.handleInput?.('\r');
      assert.match(component.render(80).join('\n'), / confirm/);
      checkWidths('questionnaire-second-tab', component);
    },
  );
});

test('task confirmation, escape, task overlay and controls render real components', async () => {
  await capture(
    (ctx) => showTaskConfirmation(ctx, renderConfirmationTasks(goal.taskList!.tasks, 0).join('\n')),
    (component) => {
      assert.match(component.render(80).join('\n'), / done/);
      assert.match(component.render(80).join('\n'), / Confirm task list/);
      checkWidths('task-confirmation', component);
    },
  );
  await capture(
    (ctx) => showEscapeDialog(ctx, goal.objective),
    (component) => {
      assert.match(component.render(80).join('\n'), / Continue working/);
      checkWidths('escape', component);
    },
  );
  await capture(
    (ctx) => showTaskListOverlay(ctx, new Map([[goal.id, goal]]), goal.id),
    (component) => {
      const lines = component.render(80).join('\n');
      assert.match(lines, //);
      assert.match(lines, //);
      assert.match(lines, //);
      checkWidths('task-overlay', component);
      component.handleInput?.('a');
      checkWidths('task-overlay-all', component);
    },
  );
  await capture(
    (ctx) =>
      ctx.ui.custom(
        (tui, th, kb, done) =>
          new GoalControlsDialog(
            { loadedCommands: undefined, interruption: { isHeld: () => false } } as unknown as GoalCore,
            ctx,
            tui,
            th,
            kb,
            done,
          ),
      ),
    (component) => {
      assert.match(component.render(80).join('\n'), //);
      checkWidths('controls-list', component);
      component.handleInput?.('\r');
      checkWidths('controls-actions', component);
    },
  );
});

test('todo overlay, tool cards, dependency markers and command rows stay consistent', () => {
  __resetState();
  const overlay = new TodoOverlay();
  let component: Component | undefined;
  replaceState('icons', { tasks, nextId: 4 });
  setActiveRenderSession('icons');
  overlay.setUICtx({
    theme,
    setWidget: (_key: string, factory: unknown) => {
      if (typeof factory === 'function') component = factory({ requestRender() {} }, theme);
    },
  } as unknown as ExtensionContext['ui']);
  try {
    overlay.update();
    assert.ok(component);
    assert.match(component.render(80).join('\n'), /.*Todos/);
    checkWidths('todo-overlay', component);
    overlay.toggleCollapse();
    checkWidths('todo-collapsed', component);
    for (const task of tasks) {
      const status = task.status === 'completed' ? '' : task.status === 'in_progress' ? '' : '';
      assert.ok(formatOverlayTaskLine(task, theme, true).startsWith(status));
      checkWidths('todo-row', new Text(formatOverlayTaskLine(task, theme, true), 0, 0));
      checkWidths('todos-command-row', new Text(formatCommandTaskLine(task, status), 0, 0));
    }
    for (const action of ['create', 'update', 'get', 'list', 'delete', 'clear'] as const) {
      checkWidths(
        `todo-call-${action}`,
        renderTodoCall({ action, id: 2, subject: 'Current' }, theme, { tasks, nextId: 4 }),
      );
      checkWidths(
        `todo-result-${action}`,
        renderTodoResult({ details: { action, params: { id: 2 }, tasks, nextId: 4 } }, theme),
      );
    }
    const failure = renderTodoResult({ content: [{ type: 'text', text: 'Failed' }] }, theme, true);
    assert.match(failure.render(80).join('\n'), / Failed/);
    checkWidths('todo-error', failure);
  } finally {
    overlay.dispose();
    __resetState();
  }
});

test('draft, tweak, notifications, creation and task details use Nerd Font markers', () => {
  const texts = [
    buildDraftConfirmationText({
      focus: 'goal',
      originalTopic: 'Icons',
      objective: goal.objective,
      autoContinue: true,
    }),
    buildTweakConfirmationText({
      currentObjective: 'Icons',
      newObjective: goal.objective,
      changeSummary: 'Nerd Font',
      sisyphus: false,
      tasks: goal.taskList!.tasks,
    }),
    buildGoalCreatedReport({ objective: goal.objective, confirmed: true }),
    buildGoalRunningNotification({ objective: goal.objective, sisyphus: false, autoContinue: true }),
    buildGoalRunningNotification({ objective: goal.objective, sisyphus: true, autoContinue: true }),
    buildGoalTaskDetailBlock(goal),
  ];
  for (const [i, text] of texts.entries()) {
    assert.match(text, /[\ue000-\uf8ff]/u, `message ${i} must include its new icon`);
    checkWidths(`message-${i}`, new Text(text, 0, 0));
  }
});
