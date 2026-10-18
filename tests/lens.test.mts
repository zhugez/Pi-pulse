import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerLens, {
  checkFileDiagnostics,
  extractSymbols,
  formatDiagnostics,
  ReadGuardTracker,
} from "../extensions/lens/index.ts";

test("lens: extractSymbols detects TypeScript & JavaScript declarations", () => {
  const tsCode = `
export interface UserProfile {
  id: string;
  name: string;
}

export class AccountService {
  constructor() {}
}

export async function fetchUser(id: string): Promise<UserProfile> {
  return { id, name: "Alice" };
}

type ID = string | number;
export const MAX_RETRY = 5;
`;

  const symbols = extractSymbols(tsCode, "service.ts");
  assert.equal(symbols.length, 5);

  const names = symbols.map((s) => s.name);
  assert.ok(names.includes("UserProfile"));
  assert.ok(names.includes("AccountService"));
  assert.ok(names.includes("fetchUser"));
  assert.ok(names.includes("ID"));
  assert.ok(names.includes("MAX_RETRY"));

  const userProfile = symbols.find((s) => s.name === "UserProfile");
  assert.equal(userProfile?.kind, "interface");
  assert.equal(userProfile?.isExported, true);

  const fetchUser = symbols.find((s) => s.name === "fetchUser");
  assert.equal(fetchUser?.kind, "function");
});

test("lens: extractSymbols detects Python declarations", () => {
  const pyCode = `
class DataProcessor:
    def __init__(self):
        pass

async def process_batch(items):
    return items
`;

  const symbols = extractSymbols(pyCode, "processor.py");
  assert.equal(symbols.length, 2);
  assert.equal(symbols[0].name, "DataProcessor");
  assert.equal(symbols[0].kind, "class");
  assert.equal(symbols[1].name, "process_batch");
  assert.equal(symbols[1].kind, "function");
});

test("lens: checkFileDiagnostics catches JSON syntax errors with line numbers", async () => {
  const badJson = `{\n  "key": "value",\n  "broken": \n}`;
  const findings = await checkFileDiagnostics("config.json", badJson);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].message, /JSON syntax error/i);
  assert.ok(findings[0].line >= 1);

  const formatted = formatDiagnostics(findings);
  assert.match(formatted, /\[code-lens\]/);
  assert.match(formatted, /config\.json/);
});

test("lens: checkFileDiagnostics passes valid ES modules, TypeScript, and TSX without false positives", async () => {
  // Valid ES module with export/import must not fail
  const goodEsm = `import path from "node:path";\nexport const answer: number = 42;\nexport function getAnswer(): number { return answer; }`;
  const esmFindings = await checkFileDiagnostics("service.ts", goodEsm);
  assert.equal(esmFindings.length, 0);

  // Valid TSX
  const goodTsx = `export function Button() { return <button type="button">Click</button>; }`;
  const tsxFindings = await checkFileDiagnostics("button.tsx", goodTsx);
  assert.equal(tsxFindings.length, 0);

  // Valid JSON
  const goodJson = `{"valid": true, "count": 10}`;
  const jsonFindings = await checkFileDiagnostics("valid.json", goodJson);
  assert.equal(jsonFindings.length, 0);
});

test("lens: checkFileDiagnostics catches real syntax errors in TS and JS", async () => {
  const brokenTs = `export const answer: number = ;`;
  const findings = await checkFileDiagnostics("broken.ts", brokenTs);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].message, /syntax error/i);
  assert.ok(findings[0].line >= 1);

  // LRU cache hit test: returns exact cached reference
  const cached = await checkFileDiagnostics("broken.ts", brokenTs);
  assert.equal(cached, findings);
});

test("lens: checkFileDiagnostics handles Python code with stdin piping and catches errors without hanging", async () => {
  const goodPy = `def calculate_total(items):\n    return sum(x.price for x in items)\n`;
  const goodFindings = await checkFileDiagnostics("calc.py", goodPy);
  assert.equal(goodFindings.length, 0);

  const badPy = `def broken_syntax(:\n    pass\n`;
  const badFindings = await checkFileDiagnostics("broken.py", badPy);
  assert.equal(badFindings.length, 1);
  assert.equal(badFindings[0].severity, "error");
  assert.match(badFindings[0].message, /syntax error/i);
});

test("lens: ReadGuardTracker lifecycle accurately distinguishes new vs existing files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "read-guard-test-"));
  try {
    const tracker = new ReadGuardTracker();
    const existingFile = join(tempDir, "existing.ts");
    const newFile = join(tempDir, "brand-new.ts");

    await writeFile(existingFile, "export const value = 1;");

    // 1. Existing file before modification: shouldWarn is TRUE
    const preExisting = tracker.checkPreModification(existingFile, tempDir);
    assert.equal(preExisting.wasExisting, true);
    assert.equal(preExisting.shouldWarn, true);

    // 2. Non-existing file before creation: shouldWarn is FALSE
    const preNew = tracker.checkPreModification(newFile, tempDir);
    assert.equal(preNew.wasExisting, false);
    assert.equal(preNew.shouldWarn, false);

    // 3. Once read is recorded: shouldWarn becomes FALSE
    tracker.markRead(existingFile, tempDir);
    const postRead = tracker.checkPreModification(existingFile, tempDir);
    assert.equal(postRead.wasExisting, true);
    assert.equal(postRead.shouldWarn, false);

    // 4. Clear resets state
    tracker.clear();
    assert.equal(tracker.size(), 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("lens: registers tools, commands, and event listeners in Pi ExtensionAPI", () => {
  const events: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  const tools: any[] = [];
  const commands: any[] = [];

  const fakePi: any = {
    on: (eventName: string, handler: (...args: unknown[]) => unknown) => {
      events[eventName] ??= [];
      events[eventName].push(handler);
    },
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, cmd: any) => commands.push({ name, ...cmd }),
  };

  registerLens(fakePi);

  assert.ok(events["session_start"]?.length);
  assert.ok(events["tool_call"]?.length);
  assert.ok(events["tool_result"]?.length);

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "code_inspect");

  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "lens");
});
