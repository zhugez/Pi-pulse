/**
 * Fast processing helpers for the local Pi extension suite.
 *
 * The request field is added only for the allowlisted models and provider
 * transports that expose OpenAI Responses semantics. Provider authentication
 * remains owned by Pi's model registry.
 */

export const FAST_SERVICE_TIER = "fast" as const;
export const PRIORITY_SERVICE_TIER = "priority" as const;

export interface FastModel {
	readonly provider: string;
	readonly id: string;
	readonly api?: string;
}

const FAST_MODEL_IDS: ReadonlySet<string> = new Set([
	"gpt-6.2-sol",
	"gpt-6.2-astra",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);

export function supportsFastMode(model: FastModel | undefined): boolean {
	if (!model || !FAST_MODEL_IDS.has(model.id)) return false;
	return model.provider === "openai-codex" ||
		((model.provider === "openai" || model.provider === "xingchiapi") &&
			model.api === "openai-responses");
}

export function applyFastMode(
	payload: unknown,
	model: FastModel | undefined,
	isUsingOAuth = false,
): unknown {
	if (!supportsFastMode(model) || !isRecord(payload)) return payload;
	const tier = model?.provider === "openai-codex" || isUsingOAuth
		? PRIORITY_SERVICE_TIER
		: FAST_SERVICE_TIER;
	return { ...payload, service_tier: tier };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
