import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";

export interface ExomResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function execExom(args: string[], cwd?: string): Promise<ExomResult> {
  return new Promise((resolve) => {
    const proc = spawn("exom", args, {
      cwd: cwd ?? process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });

    proc.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
    });
  });
}

export function resolveVaultRoot(): string | undefined {
  if (process.env.EXOMIND_NOTES_ROOT?.trim()) {
    return process.env.EXOMIND_NOTES_ROOT.trim();
  }
  const yasna = path.join(os.homedir(), "Yasna-Memory");
  return yasna;
}

export default function registerExoMind(pi: ExtensionAPI): void {
  // 1. Tool: exom_recall
  pi.registerTool({
    name: "exom_recall",
    label: "ExoMind Recall",
    description:
      "Recall relevant architectural patterns, past decisions, personal notes, and preferences from the ExoMind second brain knowledge graph.",
    promptSnippet: "Recall long-term memory and knowledge context from ExoMind",
    promptGuidelines: [
      "Use exom_recall when the user mentions past projects, preferences, previous discussions, or personal memory.",
      "The query should be a concise concept, project name, or question.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "The topic, concept, or search query to recall from memory.",
      }),
      topk: Type.Optional(
        Type.Number({
          description: "Maximum number of top memory items to return (default: 5).",
        }),
      ),
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
      const { query, topk = 5 } = params as { query: string; topk?: number };
      const vault = resolveVaultRoot();
      const args = ["pi-context", "--query", query, "--topk", String(topk)];
      if (vault) {
        args.push("--notes-root", vault);
      }

      const { stdout, stderr, exitCode } = await execExom(args);
      if (exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `ExoMind recall failed: ${stderr || "unknown error"}`,
            },
          ],
          details: { ok: false, error: stderr },
        };
      }

      return {
        content: [{ type: "text", text: stdout.trim() || "No relevant memory found." }],
        details: { ok: true, query, topk },
      };
    },
  });

  // 2. Tool: exom_capture
  pi.registerTool({
    name: "exom_capture",
    label: "ExoMind Capture",
    description:
      "Capture a new observation, technical decision, user preference, or architectural lesson into the ExoMind memory inbox.",
    promptSnippet: "Capture persistent memory into ExoMind",
    promptGuidelines: [
      "Use exom_capture when you learn an important preference, decision, or lesson that should be remembered across future sessions.",
    ],
    parameters: Type.Object({
      input: Type.String({
        description:
          "The text to remember. Can optionally include typed relations like REL:CAUSED_BY(A->B)[0.8].",
      }),
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
      const { input } = params as { input: string };
      const vault = resolveVaultRoot();
      const args = ["capture", "--input", input];
      if (vault) {
        args.push("--notes-root", vault);
      }

      const { stdout, stderr, exitCode } = await execExom(args);
      if (exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `ExoMind capture failed: ${stderr || "unknown error"}`,
            },
          ],
          details: { ok: false, error: stderr },
        };
      }

      return {
        content: [{ type: "text", text: stdout.trim() }],
        details: { ok: true, input },
      };
    },
  });

  // 3. Slash command: /remember <text>
  pi.registerCommand("remember", {
    description: "Capture a note, rule, or preference directly into ExoMind memory inbox",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui?.notify?.("Usage: /remember <text or decision to save>", "warning");
        return;
      }

      const vault = resolveVaultRoot();
      const cmdArgs = ["capture", "--input", trimmed];
      if (vault) {
        cmdArgs.push("--notes-root", vault);
      }

      const { stdout, stderr, exitCode } = await execExom(cmdArgs);
      if (exitCode === 0) {
        ctx.ui?.notify?.(`🧠 Saved to ExoMind:\n${stdout.trim()}`, "info");
      } else {
        ctx.ui?.notify?.(`Failed to save memory: ${stderr}`, "error");
      }
    },
  });

  // 4. Slash command: /recall <query>
  pi.registerCommand("recall", {
    description: "Search and display relevant notes from ExoMind memory graph",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const query = args.trim();
      if (!query) {
        ctx.ui?.notify?.("Usage: /recall <query>", "warning");
        return;
      }

      const vault = resolveVaultRoot();
      const cmdArgs = ["pi-context", "--query", query, "--topk", "3"];
      if (vault) {
        cmdArgs.push("--notes-root", vault);
      }

      const { stdout, stderr, exitCode } = await execExom(cmdArgs);
      if (exitCode === 0 && stdout.trim()) {
        ctx.ui?.notify?.(stdout.trim(), "info");
      } else {
        ctx.ui?.notify?.(`No memories found for "${query}" (or error: ${stderr})`, "warning");
      }
    },
  });

  // 5. Session start & prompt injection: Auto-recall memory context for current project
  let recalledMemory: string | undefined;

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    recalledMemory = undefined;
    try {
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      const projectName = path.basename(cwd);
      if (!projectName || projectName === "home" || projectName === "dev") {
        return;
      }

      const vault = resolveVaultRoot();
      const args = ["pi-context", "--query", projectName, "--topk", "2"];
      if (vault) {
        args.push("--notes-root", vault);
      }

      const { stdout, exitCode } = await execExom(args);
      if (exitCode === 0 && stdout.includes("<exomind_memory")) {
        recalledMemory = stdout.trim();
      }
    } catch {
      // Best-effort context recall
    }
  });

  pi.on("before_agent_start", async (event: any) => {
    if (!recalledMemory) {
      if (event?.systemPromptOptions?.sections) {
        delete event.systemPromptOptions.sections.exomind;
      }
      return;
    }

    const sections = event?.systemPromptOptions?.sections;
    if (sections && typeof sections === "object") {
      sections.exomind = recalledMemory;
      return;
    }

    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}${recalledMemory}` };
  });
}
