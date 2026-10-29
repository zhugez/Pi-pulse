import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ADVISOR_TOOL_NAMES = new Set(["ask_advisor", "record_advisor_outcome"]);

export const setAdvisorToolsActive = (
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  enabled: boolean
) => {
  const current = pi.getActiveTools();

  const next = current.filter(
    (name) => enabled || !ADVISOR_TOOL_NAMES.has(name)
  );

  if (enabled) {
    for (const name of ADVISOR_TOOL_NAMES) {
      if (!next.includes(name)) {
        next.push(name);
      }
    }
  }

  if (
    next.length !== current.length ||
    next.some((name, index) => name !== current[index])
  ) {
    pi.setActiveTools(next);
  }
};
