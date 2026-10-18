import * as vm from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";

const execFileAsync = promisify(execFile);

export interface DiagnosticFinding {
  file: string;
  line: number;
  column?: number;
  severity: "error" | "warning";
  message: string;
}

// Bounded LRU cache for deterministic diagnostic results
const DIAGNOSTIC_CACHE_LIMIT = 128;
const diagnosticCache = new Map<string, DiagnosticFinding[]>();

function contentHash(filePath: string, content: string): string {
  return createHash("sha256").update(filePath).update("\0").update(content).digest("hex");
}

export async function checkFileDiagnostics(
  filePath: string,
  content: string,
): Promise<DiagnosticFinding[]> {
  const hash = contentHash(filePath, content);
  const cached = diagnosticCache.get(hash);
  if (cached) return cached;

  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const findings: DiagnosticFinding[] = [];

  if (ext === ".json") {
    try {
      JSON.parse(content);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Try to extract line and column from JSON.parse error message
      const match = /line\s+(\d+)\s+column\s+(\d+)/i.exec(msg);
      findings.push({
        file: filePath,
        line: match ? Number.parseInt(match[1], 10) : 1,
        column: match ? Number.parseInt(match[2], 10) : 1,
        severity: "error",
        message: `JSON syntax error: ${msg}`,
      });
    }
  } else if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
    // Node 24 native TypeScript syntax validation
    try {
      const stripped = stripTypeScriptTypes(content, { mode: "strip" });
      new vm.Script(stripped, { filename: filePath });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      let line = 1;
      const lineMatch = /:(\d+)(?::(\d+))?/.exec((err instanceof Error ? err.stack : "") || "");
      if (lineMatch) line = Number.parseInt(lineMatch[1], 10);
      findings.push({
        file: filePath,
        line,
        severity: "error",
        message: `TypeScript syntax error: ${msg}`,
      });
    }
  } else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    try {
      // Parse syntax without executing
      new vm.Script(content, { filename: filePath });
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        // SyntaxError on vm.Script has stack with line info
        const stackLines = (err.stack || "").split("\n");
        let line = 1;
        const lineMatch = /:(\d+)(?::(\d+))?/.exec(stackLines[0] || "");
        if (lineMatch) line = Number.parseInt(lineMatch[1], 10);
        findings.push({
          file: filePath,
          line,
          severity: "error",
          message: `JavaScript syntax error: ${err.message}`,
        });
      }
    }
  } else if (ext === ".py") {
    try {
      // Use python3 py_compile via stdin to check syntax
      await execFileAsync("python3", ["-c", `
import sys, py_compile, tempfile, os
code = sys.stdin.read()
with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
    f.write(code)
    tmp_name = f.name
try:
    py_compile.compile(tmp_name, doraise=True)
except py_compile.PyCompileError as e:
    sys.stderr.write(str(e))
    sys.exit(1)
finally:
    if os.path.exists(tmp_name):
        os.remove(tmp_name)
`], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
    } catch (err: unknown) {
      const execError = err as { stderr?: string; message?: string };
      const stderr = execError?.stderr || "";
      const lineMatch = /line\s+(\d+)/i.exec(stderr);
      findings.push({
        file: filePath,
        line: lineMatch ? Number.parseInt(lineMatch[1], 10) : 1,
        severity: "error",
        message: `Python syntax error: ${stderr.trim() || execError?.message || String(err)}`,
      });
    }
  }

  // Manage bounded cache
  if (diagnosticCache.size >= DIAGNOSTIC_CACHE_LIMIT) {
    const oldestKey = diagnosticCache.keys().next().value;
    if (oldestKey) diagnosticCache.delete(oldestKey);
  }
  diagnosticCache.set(hash, findings);

  return findings;
}

export function formatDiagnostics(findings: DiagnosticFinding[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map(
    (f) => `  Line ${f.line}${f.column ? `:${f.column}` : ""}: [${f.severity}] ${f.message}`,
  );
  return `[code-lens] Diagnostics found issues in ${findings[0].file}:\n${lines.join("\n")}`;
}
