import {
  advisorRef,
  contextMaxCharsRef,
  executorRef,
  setAdvisorRef,
  setContextMaxCharsRef,
  setExecutorRef,
} from "./state.ts";
import { MAX_CONTEXT_MAX_CHARS } from "./types.ts";
import { isValidContextMaxChars } from "./validation.ts";

const ARGUMENT_WHITESPACE = /\s+/u;

export const parseArgs = (args: string): string | undefined => {
  let nextExecutor = executorRef;
  let nextAdvisor = advisorRef;
  let nextContextMaxChars = contextMaxCharsRef;

  for (const token of args.trim().split(ARGUMENT_WHITESPACE).filter(Boolean)) {
    const separator = token.indexOf("=");
    const key = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? undefined : token.slice(separator + 1);

    if (key === "executor" && value) {
      nextExecutor = value;
    }

    if (key === "advisor" && value) {
      nextAdvisor = value;
    }

    if (key === "contextMaxChars") {
      const parsed = Number(value);

      if (!isValidContextMaxChars(parsed)) {
        return `contextMaxChars must be a non-negative integer no greater than ${MAX_CONTEXT_MAX_CHARS}.`;
      }

      nextContextMaxChars = parsed;
    }
  }

  setExecutorRef(nextExecutor);
  setAdvisorRef(nextAdvisor);
  setContextMaxCharsRef(nextContextMaxChars);
};
