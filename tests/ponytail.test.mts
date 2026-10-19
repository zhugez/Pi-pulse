// /home/dev/pi-pulse/tests/ponytail.test.mts
import assert from "node:assert/strict";
import test from "node:test";
import registerPonytail from "../extensions/ponytail/index.js";

test("ponytail: registers /pnt-opt alias alongside upstream ponytail commands", async () => {
  const commands = new Map<string, any>();
  const sentMessages: Array<{ text: string; options: any }> = [];

  const fakePi: any = {
    registerCommand: (name: string, def: any) => commands.set(name, def),
    on: () => {},
    appendEntry: () => {},
    sendUserMessage: (text: string, options?: any) => {
      sentMessages.push({ text, options });
    },
  };

  registerPonytail(fakePi);

  assert.ok(commands.has("ponytail"));
  assert.ok(commands.has("ponytail-audit"));
  assert.ok(commands.has("pnt-opt"));

  await commands.get("pnt-opt").handler("", { isIdle: () => true });
  await commands.get("pnt-opt").handler("extensions/", { isIdle: () => false, ui: { notify() {} } });

  assert.deepEqual(sentMessages, [
    { text: "/skill:ponytail-audit", options: { expandPromptTemplates: true } },
    {
      text: "/skill:ponytail-audit extensions/",
      options: { deliverAs: "followUp", expandPromptTemplates: true },
    },
  ]);
});
