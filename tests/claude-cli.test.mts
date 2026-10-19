import assert from "node:assert/strict";
import test from "node:test";
import { parseLine } from "../extensions/claude-cli/src/stream-parser.js";
import { cliThinkingLevelMap } from "../extensions/claude-cli/src/thinking-config.js";
import { validateCliPresence } from "../extensions/claude-cli/src/process-manager.js";
import { CUSTOM_TOOLS_MCP_PREFIX } from "../extensions/claude-cli/src/tool-mapping.js";

test("claude-cli: validateCliPresence detects installed claude binary", () => {
  // Claude is installed on the machine
  assert.doesNotThrow(() => validateCliPresence());
});

test("claude-cli: stream-parser safely parses NDJSON and ignores corrupt noise", () => {
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("   "), null);
  assert.equal(parseLine("invalid json text"), null);
  assert.equal(parseLine("DEBUG: raw logging info"), null);

  const valid = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
  });
  const parsed = parseLine(valid);
  assert.ok(parsed);
  assert.equal(parsed.type, "stream_event");
});

test("claude-cli: thinkingLevelMap handles thinking levels correctly", () => {
  const modelWithThinking = {
    thinkingLevelMap: { off: "off", low: "low", high: "high" },
    compat: { forceAdaptiveThinking: true },
  } as any;

  const map = cliThinkingLevelMap(modelWithThinking);
  assert.ok(map);
  assert.equal(map.off, "off");
  assert.equal(map.minimal, null);

  const modelWithoutThinking = {} as any;
  const noMap = cliThinkingLevelMap(modelWithoutThinking);
  assert.equal(noMap, undefined);
});

test("claude-cli: tool mapping MCP prefix is defined", () => {
  assert.equal(typeof CUSTOM_TOOLS_MCP_PREFIX, "string");
  assert.ok(CUSTOM_TOOLS_MCP_PREFIX.length > 0);
});
