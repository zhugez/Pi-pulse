import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';

// Shared plumbing for the external quality gates (crapper, mutator). Both are
// Python CLIs that self-bootstrap a venv, print a report on stdout, and use
// non-zero exit codes to mean "the gate failed" rather than "the tool broke".

export const MAX_OUTPUT_BYTES = 64 * 1024;

export type GateRunResult = {
  /** ok covers both "clean" and "gate failed"; the tool ran either way. */
  status: 'ok' | 'missing' | 'error';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  message?: string;
};

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discovery order: an env override, then the name on PATH, then the project's
 * own launcher in the working directory (both tools ship a `./tool` script that
 * creates .venv on first run).
 */
export function resolveExecutable(
  name: string,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  isRunnable: (path: string) => boolean = (path) => existsSync(path) && isExecutable(path),
): string | undefined {
  const override = env[`PI_${name.toUpperCase()}`];
  if (override && isRunnable(override)) return override;

  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isRunnable(candidate)) return candidate;
  }

  const local = join(cwd, name);
  if (isRunnable(local)) return local;
  return undefined;
}

export function runProcess(options: {
  binary: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Exit codes that mean "the gate ran and reported a result". */
  okExitCodes: number[];
}): Promise<GateRunResult> {
  const { binary, args, cwd, timeoutMs, okExitCodes } = options;
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const out = stdout ?? '';
        const err = stderr ?? '';
        if (!error) {
          resolve({ status: 'ok', stdout: out, stderr: err, exitCode: 0 });
          return;
        }
        const code = (error as { code?: number | string }).code;
        if (code === 'ENOENT') {
          resolve({ status: 'missing', stdout: out, stderr: err, exitCode: null, message: `${binary} not found` });
          return;
        }
        if (typeof code === 'number' && okExitCodes.includes(code)) {
          resolve({ status: 'ok', stdout: out, stderr: err, exitCode: code });
          return;
        }
        resolve({
          status: 'error',
          stdout: out,
          stderr: err,
          exitCode: typeof code === 'number' ? code : null,
          message: error.message,
        });
      },
    );
  });
}
