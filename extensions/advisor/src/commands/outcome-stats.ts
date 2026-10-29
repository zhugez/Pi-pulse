import { aggregateOutcomeRecords, readOutcomeLog } from "../outcome-stats.ts";
import type { OutcomeStats } from "../outcome-stats.ts";
import { OUTCOME_LOG_MAX_BYTES } from "../outcomes.ts";
import type { CommandRuntime } from "./types.ts";

export interface AdvisorStatsDetails {
  error?: string;
  malformedLines: number;
  stats?: OutcomeStats;
}

const percent = (rate: number | undefined) =>
  rate === undefined ? "n/a" : `${(rate * 100).toFixed(1)}%`;

const validatedCount = (value: { failed: number; passed: number }) =>
  value.failed + value.passed;

const timestamp = (value: string | undefined) =>
  value ? new Date(value).toLocaleString() : "n/a";

export const formatAdvisorStats = ({
  error,
  malformedLines,
  stats,
}: AdvisorStatsDetails): string => {
  if (error) {
    return `**Could not read Advisor outcomes.**\n\n${error}`;
  }

  if (!stats || stats.total === 0) {
    const ignored = malformedLines
      ? `\n\nIgnored ${malformedLines} malformed ledger line${malformedLines === 1 ? "" : "s"}.`
      : "";

    return `**No Advisor outcomes recorded yet.**\n\nEnable outcome logging and record an outcome after an Advisor response to build this report.${ignored}`;
  }

  const { validationByAdoption } = stats;
  const { followed } = validationByAdoption;
  const notFollowed = validationByAdoption["not-followed"];

  const triggerLines = Object.entries(stats.byTrigger).map(
    ([trigger, count]) => `- ${trigger}: ${count}`
  );

  const adoptionLines = Object.entries(stats.adoption).map(
    ([adoption, count]) => `- ${adoption}: ${count}`
  );

  const validationLines = [
    `- followed: ${percent(followed.passRate)} passed (${followed.passed}/${validatedCount(followed)})`,
    `- not-followed: ${percent(notFollowed.passRate)} passed (${notFollowed.passed}/${validatedCount(notFollowed)})`,
  ];

  const ignored = malformedLines
    ? `\n\nIgnored ${malformedLines} malformed ledger line${malformedLines === 1 ? "" : "s"}.`
    : "";

  return [
    `**${stats.total} Advisor outcome${stats.total === 1 ? "" : "s"}**`,
    "",
    "**By trigger**",
    ...triggerLines,
    "",
    "**Adoption**",
    ...adoptionLines,
    "",
    "**Validation passed rate (passed / passed + failed)**",
    ...validationLines,
    "",
    `Distinct advices seen: ${stats.distinctAdvices}`,
    `Time window: ${timestamp(stats.firstTimestamp)} → ${timestamp(stats.lastTimestamp)}`,
    `Ledger window: capped at ${OUTCOME_LOG_MAX_BYTES / (1024 * 1024)} MiB and rewritten on overflow; this report covers only retained records.${ignored}`,
  ].join("\n");
};

const readAdvisorStats = async (): Promise<AdvisorStatsDetails> => {
  try {
    const log = await readOutcomeLog();
    const stats = aggregateOutcomeRecords(log.records, log.malformedLines);

    return { malformedLines: log.malformedLines, stats };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      malformedLines: 0,
    };
  }
};

export const registerOutcomeStatsCommand = (runtime: CommandRuntime) => {
  runtime.pi.registerCommand("advisor-stats", {
    description: "Show retained Advisor outcome adoption and validation stats",
    handler: async (_args, _ctx) => {
      const details = await readAdvisorStats();
      runtime.pi.sendMessage(
        {
          content: [],
          customType: "advisor-stats-result",
          details,
          display: true,
        },
        { deliverAs: "steer", triggerTurn: false }
      );
    },
  });
};
