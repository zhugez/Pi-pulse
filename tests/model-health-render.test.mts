import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderModelHealth } from "../extensions/subscription-usage.ts";

const plain = { fg: (_color: string, text: string) => text };
const health = new Map([
 ["hms/deepseek-v4.1-flash-free", { ok: true, elapsed: 8805 }],
 ["xingchiapi/gpt-6.1-sol", { ok: true, elapsed: 23840 }],
 ["xingchiapi/gpt-6-astra", { ok: false, elapsed: 969 }],
]);

test("health row keeps qualified model values together in a shared gutter", () => {
 assert.deepEqual(renderModelHealth(health, plain, 80), [
  "health   hms/Flash ✓ 8.8s   xingchi/Sol ✓ 23.8s   xingchi/Astra !",
 ]);
 assert.deepEqual(renderModelHealth(health, plain, 30), [
  "health   hms/Flash ✓ 8.8s", "         xingchi/Sol ✓ 23.8s", "         xingchi/Astra !",
 ]);
 for (const width of [120, 80, 40, 30, 20, 1]) {
  const lines = renderModelHealth(health, plain, width);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
  const text = lines.join("").replaceAll(" ", "");
  for (const label of ["hms/", "xingchi/", "Flash", "Sol", "Astra", "!"]) assert.ok(text.includes(label));
 }
 const narrow = renderModelHealth(new Map([["hms/deepseek-v4.1-flash-free", { ok: true, elapsed: 27700 }]]), plain, 25);
 assert.match(narrow[0]!, /health.*hms\/Flash/);
 assert.ok(narrow.join("").replaceAll(" ", "").includes("hms/Flash✓27.7s"));
 assert.equal(renderModelHealth(health, plain, 80).length, 1);
 assert.ok(!renderModelHealth(health, plain, 80).join("").includes("○"));
});

test("health toolbar uses theme status colors and preserves pending and subsecond results", () => {
 const themed = { fg: (color: string, text: string) => `\x1b[${color === "success" ? "32" : "33"}m${text}\x1b[0m` };
 const states = new Map([["hms/pending", {}], ["xingchiapi/fast", { ok: true, elapsed: 8 }]]);
 assert.match(renderModelHealth(states, plain, 120).join(""), /pending ○.*fast ✓ 8ms/);
 for (const width of [80, 20, 1]) assert.ok(renderModelHealth(states, themed, width).every((line) => visibleWidth(line) <= width));
 const colored = renderModelHealth(states, themed, 120).join("");
 assert.ok(colored.includes(themed.fg("success", "✓")));
 assert.ok(colored.includes(themed.fg("muted", "hms/")));
 assert.ok(colored.includes(themed.fg("muted", "xingchi/")));
 const grouped = renderModelHealth(health, themed, 120, { compact: { tokens: 0, limit: 30, contextWindow: 100 }, fast: "on" }).join("");
 assert.ok(grouped.includes("38;2;116;199;236mhealth "));
 assert.ok(grouped.includes("38;2;137;220;235mFlash"));
 assert.ok(grouped.includes("38;2;180;190;254mSol"));
 assert.ok(grouped.includes("38;2;250;179;135mAstra"));
 assert.ok(grouped.includes("38;2;148;226;213msession"));
 assert.ok(grouped.includes("38;2;148;226;213min 31"));
 assert.ok(grouped.includes(themed.fg("muted", " (30%)")));
 const light = { ...themed, appearance: "light" };
 const lightRows = renderModelHealth(health, light, 120, { fast: "on" });
 assert.ok(!lightRows.join("").includes("38;2;"));
 assert.ok(lightRows.join("").includes(themed.fg("warning", "Astra")));
 assert.ok(!renderModelHealth(states, plain, 120).join("").includes("\x1b"));
 assert.deepEqual(renderModelHealth(states, plain, 0), []);
 assert.deepEqual(renderModelHealth(new Map(), plain, 80), []);
});

test("health toolbar wraps wide and combining characters without dropping labels or results", () => {
 const states = new Map([["vendor/模型é", { ok: false }], ["another/unknown-very-long-model-name", { ok: true, elapsed: 8 }]]);
 for (let width = 2; width <= 120; width++) {
  const lines = renderModelHealth(states, plain, width);
  assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
  const text = lines.join("").replaceAll(" ", "");
  for (const value of ["vendor/", "模型é!", "another/", "unknown-very-long-model-name✓8ms"]) assert.ok(text.includes(value), value);
  assert.ok(lines.every((line) => !line.startsWith("│") && !line.endsWith("│")));
 }
});

test("health toolbar preserves unknown IDs and disambiguates alias collisions", () => {
 const states = new Map([
  ["xingchiapi/gpt-6.1-sol", { ok: true }],
  ["xingchiapi/Sol", { ok: false }],
  ["hms/long-unknown-model-id", {}],
 ]);
 for (const width of [120, 20, 1]) {
  const lines = renderModelHealth(states, plain, width);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
  const text = lines.join("").replaceAll(" ", "");
  for (const label of ["gpt-6.1-sol✓", "Sol!", "long-unknown-model-id○"]) assert.ok(text.includes(label));
 }
});
