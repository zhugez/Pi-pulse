import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  advisorDisableSameModelRef,
  advisorModelWhitelistRef,
  advisorRef,
  splitRef,
} from "../config/state.ts";

type AdvisorModelAccess =
  | { allowed: true; modelRef?: string }
  | { allowed: false; modelRef?: string; reason: string };

const currentModelRef = (
  ctx: Pick<ExtensionContext, "model">
): string | undefined => {
  const { model } = ctx;

  return model ? `${model.provider}/${model.id}` : undefined;
};

export const advisorModelAccess = (
  ctx: Pick<ExtensionContext, "model">
): AdvisorModelAccess => {
  const modelRef = currentModelRef(ctx);

  if (advisorModelWhitelistRef.length === 0) {
    return modelRef ? { allowed: true, modelRef } : { allowed: true };
  }

  if (modelRef && advisorModelWhitelistRef.includes(modelRef)) {
    return { allowed: true, modelRef };
  }

  const current = modelRef ?? "no current model";

  const denial: AdvisorModelAccess = {
    allowed: false,
    reason: `Advisor calls are restricted to the configured model whitelist (${advisorModelWhitelistRef.join(", ")}). Current model: ${current}.`,
  };

  if (modelRef) {
    denial.modelRef = modelRef;
  }

  return denial;
};

export const sameModelAdvisorDisabled = (
  ctx: Pick<ExtensionContext, "model">,
  model: { id: string; provider: string } | undefined = ctx.model,
  advisorModelRef: string | undefined = advisorRef
): boolean => {
  const selectedAdvisorRef = advisorModelRef ?? advisorRef;

  if (!(advisorDisableSameModelRef && selectedAdvisorRef && model)) {
    return false;
  }

  const [provider, id] = splitRef(selectedAdvisorRef);

  return provider === model.provider && id === model.id;
};

export const sameModelAdvisorNotice =
  "Advisor disabled: executor and advisor are the same model.";

export const fallbackSameModelAdvisorNotice =
  "Advisor fallback skipped: executor and fallback Advisor are the same model.";

export const advisorModelIsAllowed = (
  ctx: Pick<ExtensionContext, "model">
): boolean => advisorModelAccess(ctx).allowed && !sameModelAdvisorDisabled(ctx);

export const advisorModelAccessReason = (
  ctx: Pick<ExtensionContext, "model">
): string | undefined => {
  const access = advisorModelAccess(ctx);

  return access.allowed ? undefined : access.reason;
};
