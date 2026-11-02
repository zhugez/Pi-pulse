import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerCodeMode, {
  runCodeSnippet,
  formatExecutionResult,
} from "../extensions/code-mode/index.ts";

test("code-mode: basic return and console output", async () => {
  const result = await runCodeSnippet(
    `console.log("hello", 123);
     return { success: true, count: 42 };`,
    {
      cwd: process.cwd(),
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    },
  );

  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0], "hello 123");
  assert.deepEqual(result.result, { success: true, count: 42 });

  const formatted = formatExecutionResult(result);
  assert.match(formatted, /<console_output>/);
  assert.match(formatted, /hello 123/);
  assert.match(formatted, /"success": true/);
});

test("code-mode: filesystem operations within cwd", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "code-mode-test-"));
  try {
    const result = await runCodeSnippet(
      `await fs.writeFile("test.txt", "sample content");
       const exists = fs.exists("test.txt");
       const content = await fs.readFile("test.txt");
       const files = await fs.readdir(".");
       return { exists, content, files };`,
      {
        cwd: tempDir,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
    );

    assert.deepEqual(result.result, {
      exists: true,
      content: "sample content",
      files: ["test.txt"],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("code-mode: parallel async operations with Promise.all", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "code-mode-parallel-"));
  try {
    const result = await runCodeSnippet(
      `const names = ["a.txt", "b.txt", "c.txt"];
       await Promise.all(names.map(name => fs.writeFile(name, "data-" + name)));
       const contents = await Promise.all(names.map(name => fs.readFile(name)));
       return contents;`,
      {
        cwd: tempDir,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
    );

    assert.deepEqual(result.result, ["data-a.txt", "data-b.txt", "data-c.txt"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("code-mode: exec command helper", async () => {
  const result = await runCodeSnippet(
    `const res = await exec("echo", ["pi-pulse-rulez"]);
     return res;`,
    {
      cwd: process.cwd(),
      exec: async (cmd, args) => ({
        stdout: `${cmd} ${args?.join(" ")}`,
        stderr: "",
        exitCode: 0,
      }),
    },
  );

  assert.deepEqual(result.result, {
    stdout: "echo pi-pulse-rulez",
    stderr: "",
    exitCode: 0,
  });
});

test("code-mode: timeout enforcement", async () => {
  await assert.rejects(
    runCodeSnippet(
      `await new Promise((resolve) => setTimeout(resolve, 500));
       return "done";`,
      {
        cwd: process.cwd(),
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        timeoutMs: 50,
      },
    ),
    /timed out/i,
  );
});

test("code-mode: runtime syntax and exception handling", async () => {
  await assert.rejects(
    runCodeSnippet(
      `throw new Error("intentional test error");`,
      {
        cwd: process.cwd(),
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
    ),
    /intentional test error/,
  );
});

test("code-mode: registers tool and slash command with pi extension API", () => {
  const tools: any[] = [];
  const commands: any[] = [];

  const fakePi: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, cmd: any) => commands.push({ name, ...cmd }),
  };

  registerCodeMode(fakePi);

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "code_exec");
  assert.ok(tools[0].promptGuidelines.length > 0);

  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "code-exec");
});

test("code-mode: exec caps buffered output and reports truncation", async () => {
  const calls: any[] = [];
  const tools: any[] = [];
  const fakePi: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: () => {},
    exec: async (cmd: string, args: string[], options: any) => {
      calls.push({ cmd, args, options });
      return { stdout: "partial", stderr: "", code: 0, truncated: true };
    },
  };

  registerCodeMode(fakePi);

  const result = await tools[0].execute(
    "call-1",
    { code: `return await exec("cat", ["big.log"]);` },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  assert.equal(calls[0].options.maxBuffer, 64 * 1024 * 1024);
  assert.match(result.content[0].text, /output exceeded 67108864 bytes; stdout and stderr are incomplete/);
});
