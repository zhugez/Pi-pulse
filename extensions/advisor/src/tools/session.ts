import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AdvisorSessionState } from "../session-state.ts";

export const advisorSessionState = new AdvisorSessionState();

const sessionStates = new WeakMap<object, AdvisorSessionState>();

export const sessionStateFor = (owner: ExtensionAPI): AdvisorSessionState => {
  const existing = sessionStates.get(owner);

  if (existing) {
    return existing;
  }

  const state = new AdvisorSessionState();
  sessionStates.set(owner, state);

  return state;
};
