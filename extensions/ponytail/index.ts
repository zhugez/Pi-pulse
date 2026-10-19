// /home/dev/pi-pulse/extensions/ponytail/index.ts
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
// @ts-expect-error untyped js module from bundled runtime dependency
import ponytailExtension from "../../node_modules/@dietrichgebert/ponytail/pi-extension/index.js";

export function sendPonytailSkill(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  skillName: string,
  args: string,
  ctx?: ExtensionCommandContext,
): void {
  const normalized = String(args || "").trim();
  const message = normalized ? `${skillName} ${normalized}` : skillName;

  if (ctx?.isIdle?.() === false) {
    pi.sendUserMessage(message, { deliverAs: "followUp", expandPromptTemplates: true });
    ctx?.ui?.notify?.(`${skillName} queued as follow-up.`, "info");
    return;
  }

  pi.sendUserMessage(message, { expandPromptTemplates: true });
}

export default function registerPonytail(pi: ExtensionAPI): void {
  ponytailExtension(pi);

  pi.registerCommand("pnt-opt", {
    description: "Run /skill:ponytail-audit (whole-repo over-engineering audit)",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      sendPonytailSkill(pi, "/skill:ponytail-audit", args, ctx);
    },
  });
}
