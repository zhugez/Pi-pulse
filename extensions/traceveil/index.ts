import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const executeFile = promisify(execFile);
type Execute = (
  binary: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;
const USAGE =
  'Usage: /traceveil [demo|doctor|help]. With no argument, analyze the current saved Pi branch. Use the full CLI inspect command printed in the report for finding details.';

export default function registerTraceveil(pi: ExtensionAPI, execute: Execute = executeFile): void {
  pi.registerCommand('traceveil', {
    description: 'Analyze the current saved Pi branch locally, or run /traceveil demo or /traceveil doctor',
    handler: async (args, ctx) => {
      if (!ctx.hasUI)
        throw new Error(
          'Use the Traceveil CLI outside interactive Pi: traceveil demo or traceveil analyze SESSION --agent pi.',
        );
      const mode = args.trim();
      if (mode === 'help' || mode === '--help') {
        ctx.ui.notify(USAGE, 'info');
        return;
      }
      if (mode && mode !== 'demo' && mode !== 'doctor') {
        ctx.ui.notify(USAGE, 'warning');
        return;
      }
      const sessionFile = mode ? undefined : ctx.sessionManager.getSessionFile();
      const leaf = mode ? undefined : ctx.sessionManager.getLeafId();
      if (!mode && (!sessionFile || !leaf)) {
        ctx.ui.notify(
          'No saved Pi branch is available. Run /traceveil demo, or save a session before analyzing it.',
          'warning',
        );
        return;
      }
      const argv = mode
        ? [mode, '--color', 'never']
        : ['analyze', '--color', 'never', '--agent', 'pi', '--leaf', leaf!, '--', sessionFile!];
      const unchanged = () =>
        !sessionFile ||
        (ctx.sessionManager.getSessionFile() === sessionFile && ctx.sessionManager.getLeafId() === leaf);
      const binary =
        process.env.TRACEVEIL_BIN ??
        join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'traceveil.exe' : 'traceveil');
      if (!isAbsolute(binary)) {
        ctx.ui.notify('TRACEVEIL_BIN must be an absolute executable path.', 'error');
        return;
      }
      const controller = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const dialog = new AbortController();
      const ui = ctx.ui;
      let replaced = false;
      const unsubscribe = pi.on('session_shutdown', () => {
        replaced = true;
        controller.abort();
        dialog.abort();
      });
      let progress: Promise<void> | undefined;
      try {
        progress = ui.select('Traceveil is running (Escape cancels)', ['Cancel'], { signal: dialog.signal })
          .then(() => { if (!dialog.signal.aborted) controller.abort(); });
        const result = await execute(binary, argv, {
          cwd: ctx.cwd,
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 256 * 1024,
          killSignal: 'SIGKILL',
          windowsHide: true,
          signal,
        });
        dialog.abort();
        await progress;
        if (replaced || signal.aborted) return;
        if (!unchanged()) {
          ctx.ui.notify(
            'The Pi branch changed while Traceveil ran. Run /traceveil again for the selected branch.',
            'warning',
          );
          return;
        }
        let report = stripVTControlCharacters(result.stdout).trim();
        if (sessionFile && leaf) {
          const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
          let completed = false;
          report = report.replace(/^([ \t]*)traceveil inspect (.+?) SESSION(.*)$/gm, (_line, indent, reference, policy) => {
            completed = true;
            return `${indent}${quote(binary)} inspect ${reference} ${quote(sessionFile)}${policy} --leaf ${quote(leaf)}`;
          });
          if (completed) {
            report = report
              .replace('Inspection template (join wrapped lines):', 'Inspection command:')
              .replace(/^[ \t]*Replace SESSION with the exact file, or --stdin with the same bytes\.\n?/m, '')
              .replace(/^[ \t]*Repeat --leaf ID if one was selected\. Policy above is pinned\.\n?/m, '');
          }
        }
        if (!report) {
          ctx.ui.notify('Traceveil returned no report. Check that the CLI is version 0.2 or newer.', 'warning');
          return;
        }
        await ctx.ui.editor('Traceveil report (edits are discarded)', report);
      } catch (error) {
        dialog.abort();
        await progress;
        if (replaced || !unchanged()) return;
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
        if (failure.code === 'ENOENT') {
          ctx.ui.notify(
            'Traceveil 0.2+ was not found. Install the Linux/WSL x86_64 CLI from https://github.com/zhugez/traceveil or set TRACEVEIL_BIN to an existing absolute executable path.',
            'warning',
          );
        } else if (
          signal.aborted ||
          failure.killed ||
          failure.code === 'ABORT_ERR' ||
          failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ) {
          ctx.ui.notify(
            'Traceveil stopped because of cancellation, timeout or the output limit. No partial report was displayed.',
            'warning',
          );
        } else {
          const message = stripVTControlCharacters([failure.stdout, failure.stderr].filter(Boolean).join('\n')).trim();
          await ctx.ui.editor(
            'Traceveil command failed (edits are discarded)',
            message || 'Unable to run Traceveil. Check its installation and permissions.',
          );
        }
      } finally {
        dialog.abort();
        unsubscribe();
      }
    },
  });
}
