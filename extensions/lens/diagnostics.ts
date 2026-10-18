import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DiagnosticFinding {
  file: string;
  line: number;
  column?: number;
  severity: "error" | "warning";
  message: string;
}

// Bounded LRU cache for deterministic diagnostic results (128 entries)
const DIAGNOSTIC_CACHE_LIMIT = 128;
const diagnosticCache = new Map<string, DiagnosticFinding[]>();

function contentHash(filePath: string, content: string): string {
  return createHash("sha256").update(filePath).update("\0").update(content).digest("hex");
}

/** Check Python syntax using child process with explicit stdin piping & timeout */
async function checkPythonSyntax(content: string, filePath: string, timeoutMs = 5000): Promise<DiagnosticFinding[]> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", `
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
`], { timeout: timeoutMs });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      resolve([{
        file: filePath,
        line: 1,
        severity: "error",
        message: `Python diagnostics process error: ${err.message}`,
      }]);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve([]);
        return;
      }
      const lineMatch = /line\s+(\d+)/i.exec(stderr);
      const line = lineMatch ? Number.parseInt(lineMatch[1], 10) : 1;
      resolve([{
        file: filePath,
        line,
        severity: "error",
        message: `Python syntax error: ${stderr.trim() || `exited with code ${code}`}`,
      }]);
    });

    // Explicitly write source and close stdin to prevent hangs
    child.stdin.write(content);
    child.stdin.end();
  });
}

/** Check TypeScript / JavaScript / TSX syntax using tsc syntactic diagnostics (TS1xxx errors) */
async function checkTsJsSyntax(content: string, filePath: string, timeoutMs = 8000): Promise<DiagnosticFinding[]> {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const tmpDir = await mkdtemp(join(tmpdir(), "lens-ts-"));
  const tmpFile = join(tmpDir, `check${ext}`);
  await writeFile(tmpFile, content, "utf8");

  try {
    const findings: DiagnosticFinding[] = await new Promise((resolve) => {
      const args = ["--noEmit", "--ignoreConfig", "--allowJs"];
      if (ext === ".tsx" || ext === ".jsx") {
        args.push("--jsx", "preserve");
      }
      args.push(tmpFile);

      const child = spawn("tsc", args, { timeout: timeoutMs });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on("error", () => resolve([])); // Fallback gracefully if tsc not on PATH
      child.on("close", () => {
        const output = stdout + "\n" + stderr;
        const lines = output.split(/\r?\n/);
        const results: DiagnosticFinding[] = [];

        for (const rawLine of lines) {
          // Match TypeScript error format: path(line,col): error TSxxxx: message
          const match = /\((\d+),(\d+)\):\s*error\s*(TS1\d{3}):\s*(.+)/.exec(rawLine);
          if (match) {
            const line = Number.parseInt(match[1], 10);
            const column = Number.parseInt(match[2], 10);
            const code = match[3];
            const msg = match[4];
            results.push({
              file: filePath,
              line,
              column,
              severity: "error",
              message: `Syntax error [${code}]: ${msg}`,
            });
          }
        }
        resolve(results);
      });
    });

    return findings;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function checkFileDiagnostics(
  filePath: string,
  content: string,
): Promise<DiagnosticFinding[]> {
  const hash = contentHash(filePath, content);
  const cached = diagnosticCache.get(hash);
  if (cached !== undefined) {
    // True LRU promotion: refresh position on hit
    diagnosticCache.delete(hash);
    diagnosticCache.set(hash, cached);
    return cached;
  }

  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  let findings: DiagnosticFinding[] = [];

  if (ext === ".json") {
    try {
      JSON.parse(content);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const match = /line\s+(\d+)\s+column\s+(\d+)/i.exec(msg);
      findings.push({
        file: filePath,
        line: match ? Number.parseInt(match[1], 10) : 1,
        column: match ? Number.parseInt(match[2], 10) : 1,
        severity: "error",
        message: `JSON syntax error: ${msg}`,
      });
    }
  } else if (
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".mts" ||
    ext === ".cts" ||
    ext === ".js" ||
    ext === ".jsx" ||
    ext === ".mjs" ||
    ext === ".cjs"
  ) {
    findings = await checkTsJsSyntax(content, filePath);
  } else if (ext === ".py") {
    findings = await checkPythonSyntax(content, filePath);
  }

  // Manage bounded LRU cache
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
