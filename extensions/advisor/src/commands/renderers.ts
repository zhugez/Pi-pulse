import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type {
  EntryRenderer,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

import { getAdvisorSettings } from "../config/state.ts";
import { isString } from "../content-utils.ts";
import {
  adviceForDisplay,
  hasSoundVerdict,
  renderAdvisorCallBox,
  renderAdvisorResponseHeader,
} from "../tools/render-common.ts";
import { formatAdvisorUsage } from "../usage.ts";
import { ManualAdvisorProgressComponent } from "./manual-progress.ts";
import { formatAdvisorStats } from "./outcome-stats.ts";
import type { AdvisorStatsDetails } from "./outcome-stats.ts";
import type { CommandRuntime } from "./types.ts";

interface ManualCallEntryDetails {
  progressId?: string;
  question?: string;
}

interface ManualResultDetails {
  advisor?: string;
  agentRulesBytes?: number;
  preferenceBytes?: number;
  text?: string;
  usage?: unknown;
}

const formatByteSize = (bytes: number) => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KiB`;
  }

  return `${bytes} B`;
};

const manualCallRenderer =
  (runtime: CommandRuntime): EntryRenderer<ManualCallEntryDetails> =>
  (entry, { expanded }, theme) => {
    const { progressId, question } = entry.data ?? {};

    const progress = progressId
      ? runtime.manualProgress.get(progressId)
      : undefined;

    return progress
      ? new ManualAdvisorProgressComponent(
          question,
          progress,
          Boolean(expanded),
          theme
        )
      : renderAdvisorCallBox(question, theme);
  };

const manualResultRenderer: MessageRenderer<ManualResultDetails> = (
  message,
  { expanded },
  theme
) => {
  const { details } = message;
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));

  const advice =
    details?.text ??
    (isString(message.content)
      ? message.content
      : "(Advisor returned no advice.)");

  // Manual consultations must render exactly like an Executor ask_advisor call.
  box.addChild(
    new Text(renderAdvisorResponseHeader(hasSoundVerdict(advice), theme), 0, 0)
  );

  if (details?.advisor) {
    box.addChild(new Text(theme.fg("dim", `  ${details.advisor}`), 0, 0));
  }

  if (getAdvisorSettings().showUsageDetails) {
    const usage = formatAdvisorUsage(details?.usage);

    if (usage) {
      box.addChild(new Text(theme.fg("dim", `  Usage: ${usage}`), 0, 0));
    }
  }

  const attachments = [
    details?.agentRulesBytes
      ? `AGENTS.md rules attached · ${formatByteSize(details.agentRulesBytes)}`
      : undefined,
    details?.preferenceBytes
      ? `Project preferences attached · ${formatByteSize(details.preferenceBytes)}`
      : undefined,
  ].filter((value): value is string => value !== undefined);

  if (attachments.length) {
    box.addChild(
      new Text(theme.fg("dim", `  ${attachments.join(" · ")}`), 0, 0)
    );
  }

  box.addChild(
    new Markdown(adviceForDisplay(advice, expanded), 0, 0, getMarkdownTheme())
  );

  return box;
};

const outcomeStatsRenderer: MessageRenderer<AdvisorStatsDetails> = (
  message,
  _options,
  theme
) => {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(
    new Text(theme.fg("accent", theme.bold("◆ ADVISOR · OUTCOME STATS")), 0, 0)
  );
  box.addChild(
    new Markdown(
      formatAdvisorStats(message.details ?? { malformedLines: 0 }),
      0,
      0,
      getMarkdownTheme()
    )
  );

  return box;
};

export const registerCommandRenderers = (runtime: CommandRuntime) => {
  runtime.pi.registerEntryRenderer?.(
    "advisor-manual-call",
    manualCallRenderer(runtime)
  );
  runtime.pi.registerMessageRenderer?.(
    "advisor-manual-result",
    manualResultRenderer
  );
  runtime.pi.registerMessageRenderer?.(
    "advisor-stats-result",
    outcomeStatsRenderer
  );
};
