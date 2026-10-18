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

test("lens: checkFileDiagnostics passes valid JSON and JS", async () => {
  const goodJson = `{"valid": true, "count": 10}`;
  const jsonFindings = await checkFileDiagnostics("valid.json", goodJson);
  assert.equal(jsonFindings.length, 0);

  const goodJs = `const x = 1; function test() { return x * 2; }`;
  const jsFindings = await checkFileDiagnostics("valid.js", goodJs);
  assert.equal(jsFindings.length, 0);
});

test("lens: checkFileDiagnostics catches JavaScript syntax errors", async () => {
  const badJs = `const x = ;`;
  const findings = await checkFileDiagnostics("broken.js", badJs);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].message, /syntax error/i);
});

test("lens: ReadGuardTracker warns on unread existing files and permits read files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "read-guard-test-"));
  try {
    const tracker = new ReadGuardTracker();
    const existingFile = join(tempDir, "existing.ts");
    const newFile = join(tempDir, "new.ts");

    await writeFile(existingFile, "console.log('original');");

    // 1. Modifying unread existing file produces a warning
    const warn = tracker.checkEdit(existingFile, tempDir);
    assert.ok(warn !== undefined);
    assert.match(warn, /modified without prior read/i);

    // 2. Modifying a brand new file does NOT produce a warning
    const newWarn = tracker.checkEdit(newFile, tempDir);
    assert.equal(newWarn, undefined);

    // 3. After marking as read, modifying produces NO warning
    tracker.markRead(existingFile, tempDir);
    const readWarn = tracker.checkEdit(existingFile, tempDir);
    assert.equal(readWarn, undefined);

    // 4. Clear resets tracker state
    assert.equal(tracker.size(), 1);
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
