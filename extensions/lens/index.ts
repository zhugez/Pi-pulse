import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { checkFileDiagnostics, formatDiagnostics } from "./diagnostics.ts";
import { extractSymbols, type CodeSymbol } from "./symbols.ts";
import { ReadGuardTracker } from "./read-guard.ts";

export { checkFileDiagnostics, formatDiagnostics } from "./diagnostics.ts";
export { extractSymbols, type CodeSymbol } from "./symbols.ts";
export { ReadGuardTracker } from "./read-guard.ts";

export default function registerLens(pi: ExtensionAPI): void {
  const readGuard = new ReadGuardTracker();

  // Reset or clear read guard on session changes
  pi.on("session_start", () => {
    readGuard.clear();
  });

  // Track reads and warn on unread edits
  pi.on("tool_call", (event) => {
    if (event.toolName === "read") {
      const targetPath = (event.input as { path?: string })?.path;
      if (typeof targetPath === "string") {
        readGuard.markRead(targetPath);
      }
    }
  });

  // Post-edit real-time diagnostics feedback
  pi.on("tool_result", async (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const targetPath = (event.input as { path?: string })?.path;
      if (typeof targetPath === "string" && !event.isError) {
        const notices: string[] = [];

        // 1. Read-guard check
        const guardNotice = readGuard.checkEdit(targetPath);
        if (guardNotice) {
          notices.push(guardNotice);
        }
        // Mark as read now since it was just edited
        readGuard.markRead(targetPath);

        // 2. Syntax & language diagnostics check
        try {
          const resolvedPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(process.cwd(), targetPath);
          const content = await fsPromises.readFile(resolvedPath, "utf8");
          const findings = await checkFileDiagnostics(targetPath, content);
          if (findings.length > 0) {
            notices.push(formatDiagnostics(findings));
          }
        } catch {
          // Ignore read errors for diagnostics
        }

        if (notices.length > 0) {
          event.content.push({
            type: "text",
            text: "\n\n" + notices.join("\n\n"),
          });
        }
      }
    }
  });

  // Register inspection tool: code_inspect
  pi.registerTool({
    name: "code_inspect",
    label: "Code Inspect (Symbols & Diagnostics)",
    description:
      "Inspect code structure without reading entire files: extract symbols (functions, classes, interfaces, types with line numbers) or run instant syntax diagnostics.",
    promptSnippet: "Inspect code symbols, outline, and diagnostics without reading entire files",
    promptGuidelines: [
      "Use code_inspect with action='symbols' to view an outline of all declarations (functions, classes, interfaces) and line numbers in a file without dumping its full contents.",
      "Use code_inspect with action='diagnostics' to verify syntax validity for JSON, JS, TS, or Python files.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Target file path to inspect." }),
      action: Type.Optional(
        Type.Union([Type.Literal("symbols"), Type.Literal("diagnostics")], {
          description: "Action to perform: 'symbols' (outline) or 'diagnostics' (syntax/errors). Default: 'symbols'.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const resolved = path.isAbsolute(params.path) ? params.path : path.resolve(ctx.cwd, params.path);
      const action = params.action ?? "symbols";

      try {
        const content = await fsPromises.readFile(resolved, "utf8");

        if (action === "diagnostics") {
          const findings = await checkFileDiagnostics(params.path, content);
          if (findings.length === 0) {
            return {
              content: [{ type: "text", text: `✓ No syntax or diagnostic issues found in ${params.path}.` }],
              details: { errorCount: 0 },
            };
          }
          return {
            content: [{ type: "text", text: formatDiagnostics(findings) }],
            details: { errorCount: findings.length },
          };
        }

        // Default: symbols outline
        readGuard.markRead(params.path, ctx.cwd);
        const symbols = extractSymbols(content, params.path);
        if (symbols.length === 0) {
          return {
            content: [{ type: "text", text: `No top-level symbols detected in ${params.path}.` }],
            details: { symbolCount: 0 },
          };
        }

        const lines = symbols.map(
          (s) => `  L${String(s.line).padEnd(4)} [${s.kind}] ${s.isExported ? "export " : ""}${s.name}`,
        );
        return {
          content: [{
            type: "text",
            text: `Symbols in ${params.path} (${symbols.length} total):\n${lines.join("\n")}`,
          }],
          details: { symbolCount: symbols.length },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error inspecting ${params.path}: ${msg}` }],
          details: { isError: true },
        };
      }
    },
  });

  // Slash commands
  pi.registerCommand("lens", {
    description: "Code lens commands: /lens symbols <file> | /lens check <file> | /lens stats",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const [subcommand, ...rest] = trimmed.split(/\s+/);
      const targetFile = rest.join(" ");

      if (subcommand === "stats") {
        const msg = `Code Lens Active. Read-guard tracking ${readGuard.size()} files in current session.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else console.log(msg);
        return;
      }

      if ((subcommand === "symbols" || subcommand === "check") && targetFile) {
        const resolved = path.isAbsolute(targetFile) ? targetFile : path.resolve(ctx.cwd, targetFile);
        try {
          const content = await fsPromises.readFile(resolved, "utf8");
          if (subcommand === "check") {
            const findings = await checkFileDiagnostics(targetFile, content);
            const msg = findings.length === 0
              ? `✓ No issues in ${targetFile}.`
              : formatDiagnostics(findings);
            if (ctx.hasUI) ctx.ui.notify(msg, findings.length === 0 ? "info" : "warning");
            else console.log(msg);
          } else {
            const symbols = extractSymbols(content, targetFile);
            const msg = `Symbols in ${targetFile}:\n` + symbols.map((s) => `  L${s.line}: [${s.kind}] ${s.name}`).join("\n");
            if (ctx.hasUI) ctx.ui.notify(msg, "info");
            else console.log(msg);
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (ctx.hasUI) ctx.ui.notify(`Lens error: ${msg}`, "error");
          else console.error(`Lens error: ${msg}`);
        }
        return;
      }

      const help = "Usage: /lens symbols <file> | /lens check <file> | /lens stats";
      if (ctx.hasUI) ctx.ui.notify(help, "warning");
      else console.log(help);
    },
  });
}
