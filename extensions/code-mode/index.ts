import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import * as fsPromises from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";

export interface CodeSnippetHelpers {
  cwd: string;
  exec: (command: string, args?: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CodeSnippetExecution {
  result: unknown;
  logs: string[];
  durationMs: number;
}

const MAX_OUTPUT_CHARS = 64_000;

function truncateOutput(text: string, maxLen = MAX_OUTPUT_CHARS): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2);
  const omitted = text.length - maxLen;
  return `${text.slice(0, half)}\n... [${omitted} characters omitted] ...\n${text.slice(-half)}`;
}

export async function runCodeSnippet(
  code: string,
  helpers: CodeSnippetHelpers,
): Promise<CodeSnippetExecution> {
  const timeoutMs = helpers.timeoutMs ?? 30_000;
  const logs: string[] = [];
  const startTime = Date.now();

  const customConsole = {
    log: (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
    },
    error: (...args: unknown[]) => {
      logs.push("[ERROR] " + args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
    },
    warn: (...args: unknown[]) => {
      logs.push("[WARN] " + args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
    },
    info: (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
    },
  };

  const safeFs = {
    readFile: (filePath: string, encoding: BufferEncoding = "utf8") => {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(helpers.cwd, filePath);
      return fsPromises.readFile(resolved, { encoding });
    },
    writeFile: (filePath: string, data: string | Uint8Array, encoding: BufferEncoding = "utf8") => {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(helpers.cwd, filePath);
      return fsPromises.writeFile(resolved, data, { encoding });
    },
    readdir: (dirPath = ".") => {
      const resolved = path.isAbsolute(dirPath) ? dirPath : path.resolve(helpers.cwd, dirPath);
      return fsPromises.readdir(resolved);
    },
    stat: (targetPath: string) => {
      const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(helpers.cwd, targetPath);
      return fsPromises.stat(resolved);
    },
    exists: (targetPath: string) => {
      const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(helpers.cwd, targetPath);
      return existsSync(resolved);
    },
  };

  // Compile async function
  // We wrap the code inside an async IIFE or function body with top-level return support
  const asyncFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor;
  const runner = new asyncFunctionConstructor(
    "fs",
    "exec",
    "console",
    "cwd",
    "path",
    `"use strict";
${code}`,
  );

  const abortController = new AbortController();
  const timeoutTimer = setTimeout(() => {
    abortController.abort(new Error(`Code execution timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  if (helpers.signal) {
    helpers.signal.addEventListener("abort", () => {
      clearTimeout(timeoutTimer);
      abortController.abort(helpers.signal?.reason || new Error("Code execution cancelled"));
    }, { once: true });
  }

  try {
    const execPromise = runner(
      safeFs,
      helpers.exec,
      customConsole,
      helpers.cwd,
      path,
    );

    const raceAbort = new Promise<never>((_, reject) => {
      abortController.signal.addEventListener("abort", () => {
        reject(abortController.signal.reason);
      }, { once: true });
    });

    const result = await Promise.race([execPromise, raceAbort]);
    clearTimeout(timeoutTimer);
    return {
      result,
      logs,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    clearTimeout(timeoutTimer);
    throw error;
  }
}

export function formatExecutionResult(exec: CodeSnippetExecution): string {
  const parts: string[] = [];

  if (exec.logs.length > 0) {
    parts.push("<console_output>\n" + exec.logs.join("\n") + "\n</console_output>");
  }

  if (exec.result !== undefined) {
    const formattedResult =
      typeof exec.result === "string"
        ? exec.result
        : JSON.stringify(exec.result, null, 2);
    parts.push("Result:\n" + truncateOutput(formattedResult));
  } else if (exec.logs.length === 0) {
    parts.push("Script completed successfully with no output.");
  }

  return parts.join("\n\n");
}

export default function registerCodeMode(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "code_exec",
    label: "Code Execution (Code Mode)",
    description:
      "Execute an async JavaScript snippet in a sandbox to orchestrate file operations, commands, and data processing in a single turn without flooding the conversation context with intermediate tool outputs.",
    promptSnippet: "Execute programmatic async JavaScript to orchestrate operations without context bloat",
    promptGuidelines: [
      "Use code_exec when you need to perform multiple reads, checks, searches, or commands in parallel or sequentially and only need the final filtered summary.",
      "The code runs as an async function body. Top-level 'await' and 'return' are supported.",
      "Available globals: 'fs' (readFile, writeFile, readdir, stat, exists), 'exec(cmd, args)', 'console.log(...)', 'cwd', 'path', 'Promise', 'JSON'.",
      "Always return the final filtered data or summary instead of dumping raw file trees or full bodies.",
    ],
    parameters: Type.Object({
      code: Type.String({
        description: "The JavaScript async function body to execute. Support await and return.",
      }),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Optional execution timeout in milliseconds (default: 30000).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "Running code snippet…" }],
        details: {},
      });

      const execHelper = async (cmd: string, args: string[] = []) => {
        const res = args.length > 0 ? await pi.exec(cmd, args) : await pi.exec("bash", ["-c", cmd]);
        return {
          stdout: res.stdout,
          stderr: res.stderr,
          exitCode: res.code,
        };
      };

      try {
        const execution = await runCodeSnippet(params.code, {
          cwd: ctx.cwd,
          exec: execHelper,
          timeoutMs: params.timeoutMs,
          signal,
        });

        const outputText = formatExecutionResult(execution);
        return {
          content: [{ type: "text", text: outputText }],
          details: { durationMs: execution.durationMs, logsCount: execution.logs.length },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Execution error: ${msg}` }],
          details: { isError: true },
        };
      }
    },
  });

  pi.registerCommand("code-exec", {
    description: "Run a quick JavaScript snippet in code mode (/code-exec <code...>)",
    handler: async (args, ctx) => {
      const code = args.trim();
      if (!code) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /code-exec <code...>", "warning");
        else console.log("Usage: /code-exec <code...>");
        return;
      }

      try {
        const execHelper = async (cmd: string, cmdArgs: string[] = []) => {
          const res = cmdArgs.length > 0 ? await pi.exec(cmd, cmdArgs) : await pi.exec("bash", ["-c", cmd]);
          return { stdout: res.stdout, stderr: res.stderr, exitCode: res.code };
        };

        const execution = await runCodeSnippet(code, {
          cwd: ctx.cwd,
          exec: execHelper,
          timeoutMs: 30_000,
        });

        const outputText = formatExecutionResult(execution);
        if (ctx.hasUI) ctx.ui.notify(outputText, "info");
        else console.log(outputText);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`Execution error: ${msg}`, "error");
        else console.error(`Execution error: ${msg}`);
      }
    },
  });
}
