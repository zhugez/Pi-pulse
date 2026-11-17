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

test("health toolbar uses two aligned provider groups with short model labels", () => {
 assert.deepEqual(renderModelHealth(health, plain, 80), [
  "HMS               XINGCHI",
  "Flash ✓ 8.8s      Sol ✓ 23.8s   Astra !",
 ]);
 assert.deepEqual(renderModelHealth(health, plain, 30), [
  "HMS", "Flash ✓ 8.8s", "XINGCHI", "Sol ✓ 23.8s   Astra !",
 ]);
 for (const width of [120, 80, 40, 30, 20, 1]) {
  const lines = renderModelHealth(health, plain, width);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
  const text = lines.join("").replaceAll(" ", "");
  for (const label of ["HMS", "XINGCHI", "Flash", "Sol", "Astra", "!"]) assert.ok(text.includes(label));
 }
 assert.equal(renderModelHealth(health, plain, 80).length, 2);
});

test("health toolbar uses theme status colors and preserves pending and subsecond results", () => {
 const themed = { fg: (color: string, text: string) => `\x1b[${color === "success" ? "32" : "33"}m${text}\x1b[0m` };
 const states = new Map([["hms/pending", {}], ["xingchiapi/fast", { ok: true, elapsed: 8 }]]);
 assert.match(renderModelHealth(states, plain, 120).join(""), /pending ○.*fast ✓ 8ms/);
 for (const width of [80, 20, 1]) assert.ok(renderModelHealth(states, themed, width).every((line) => visibleWidth(line) <= width));
 const colored = renderModelHealth(states, themed, 120).join("");
 assert.ok(colored.includes("\x1b[22;38;2;166;227;161m✓"));
 assert.ok(colored.includes("\x1b[22;38;2;116;199;236mHMS"));
 assert.ok(colored.includes("\x1b[22;38;2;203;166;247mXINGCHI"));
 assert.ok(renderModelHealth(health, themed, 120).join("").includes("\x1b[22;38;2;250;179;135mAstra"));
 assert.ok(!renderModelHealth(states, plain, 120).join("").includes("\x1b"));
 assert.deepEqual(renderModelHealth(states, plain, 0), []);
 assert.deepEqual(renderModelHealth(new Map(), plain, 80), []);
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
