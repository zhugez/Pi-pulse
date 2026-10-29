import { isNumber, isRecord, isString } from "../content-utils.ts";
import type { JsonValue, RecordValue } from "../content-utils.ts";
import { OPENAI_DECISIONS_MODEL } from "./decisions-client.ts";
import type {
  DecisionsQuestion,
  DecisionsScoreQuestion,
} from "./decisions-client.ts";
import { JevFailureError } from "./failure.ts";

interface DecisionsUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface NormalizedDecisionsResponse {
  answers: RecordValue;
  model: string;
  usage: DecisionsUsage;
}

interface DecisionsApiResponse {
  answers: RecordValue[];
  model?: string;
  usage: RecordValue;
}

const malformedResponse = (detail: string): JevFailureError =>
  new JevFailureError("malformed", `OpenAI Decisions response ${detail}.`);

const boundedProbability = (
  value: JsonValue | undefined
): number | undefined =>
  isNumber(value) && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;

const normalizePredicateAnswer = (answer: RecordValue): RecordValue => {
  const probability = boundedProbability(answer.probability);

  if (probability === undefined) {
    throw malformedResponse("has an invalid predicate probability");
  }

  return { noul: probability, type: "noul" };
};

const normalizeScoreAnswer = (
  answer: RecordValue,
  question: DecisionsScoreQuestion
): RecordValue => {
  if (!Array.isArray(answer.probabilities)) {
    throw malformedResponse("has no score probability array");
  }

  if (answer.probabilities.length !== question.levels.length) {
    throw malformedResponse("has an incomplete score probability array");
  }

  const probabilities: Record<string, number> = {};
  const legend: Record<string, string> = {};
  const seenLabels = new Set<string>();
  const seenValues = new Set<number>();
  let probabilityTotal = 0;

  for (const entry of answer.probabilities) {
    if (!isRecord(entry)) {
      throw malformedResponse("has an invalid score probability entry");
    }

    const { label, value } = entry;
    const probability = boundedProbability(entry.probability);

    if (
      !isString(label) ||
      !isNumber(value) ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value >= question.levels.length ||
      probability === undefined ||
      seenLabels.has(label) ||
      seenValues.has(value)
    ) {
      throw malformedResponse("has an invalid or duplicate score level");
    }

    const level = question.levels[value];

    if (label !== level.label) {
      throw malformedResponse("has an ambiguous score label/value pair");
    }

    seenLabels.add(label);
    seenValues.add(value);
    probabilities[String(value)] = probability;
    legend[String(value)] = level.description;
    probabilityTotal += probability;
  }

  if (
    Math.abs(probabilityTotal - 1) > 0.02 ||
    question.levels.some(
      (level, index) => !seenValues.has(index) || !seenLabels.has(level.label)
    )
  ) {
    throw malformedResponse(
      "has an incomplete or ambiguous score distribution"
    );
  }

  return { legend, probabilities, type: "score" };
};

const usageTokenCount = (value: JsonValue | undefined): number | undefined =>
  isNumber(value) && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

export const parseDecisionsApiResponse = async (
  response: Response
): Promise<DecisionsApiResponse> => {
  let value: unknown;

  try {
    value = await response.json();
  } catch {
    throw malformedResponse("was not valid JSON");
  }

  if (!isRecord(value)) {
    throw malformedResponse("is not an object");
  }

  const { answers: rawAnswers, model, usage } = value;

  if (!Array.isArray(rawAnswers)) {
    throw malformedResponse("did not include an answers array");
  }

  if (!isRecord(usage)) {
    throw malformedResponse("has malformed usage");
  }

  if (model !== undefined && !isString(model)) {
    throw malformedResponse("has an invalid model name");
  }

  const answers: RecordValue[] = [];

  for (const answer of rawAnswers) {
    if (!isRecord(answer)) {
      throw malformedResponse("contains an invalid answer");
    }

    answers.push(answer);
  }

  return { answers, model: isString(model) ? model : undefined, usage };
};

const normalizeAnswers = (
  responseAnswers: RecordValue[],
  questions: DecisionsQuestion[]
): RecordValue => {
  const expected = new Map(
    questions.map((question) => [question.name, question])
  );

  if (expected.size !== questions.length || expected.size === 0) {
    throw malformedResponse(
      "has duplicate or missing requested question names"
    );
  }

  const received = new Map<string, RecordValue>();

  for (const answer of responseAnswers) {
    const { name } = answer;

    if (!isString(name) || !name) {
      throw malformedResponse("contains an unnamed answer");
    }

    if (!expected.has(name)) {
      throw malformedResponse("contains an unexpected answer");
    }

    if (received.has(name)) {
      throw malformedResponse("contains duplicate answer names");
    }

    if (answer.type === "refusal") {
      throw malformedResponse("contains a refusal");
    }

    received.set(name, answer);
  }

  if (received.size !== expected.size) {
    throw malformedResponse("is missing one or more named answers");
  }

  const answers: RecordValue = {};

  for (const question of questions) {
    const answer = received.get(question.name);

    if (!answer || answer.type !== question.type) {
      throw malformedResponse("has an answer with the wrong type");
    }

    answers[question.name] =
      question.type === "predicate"
        ? normalizePredicateAnswer(answer)
        : normalizeScoreAnswer(answer, question);
  }

  return answers;
};

export const normalizeDecisionsResponse = (
  response: DecisionsApiResponse,
  questions: DecisionsQuestion[]
): NormalizedDecisionsResponse => {
  const inputTokens = usageTokenCount(response.usage.input_tokens);
  const outputTokens = usageTokenCount(response.usage.output_tokens);

  if (inputTokens === undefined || outputTokens === undefined) {
    throw malformedResponse("has malformed usage");
  }

  return {
    answers: normalizeAnswers(response.answers, questions),
    model: response.model || OPENAI_DECISIONS_MODEL,
    usage: { inputTokens, outputTokens },
  };
};
