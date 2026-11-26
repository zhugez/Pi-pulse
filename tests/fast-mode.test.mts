import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerFastMode, {
	applyFastMode,
	supportsFastMode,
} from "../extensions/fast-mode/index.ts";

const xingchiModel = {
	provider: "xingchiapi",
	id: "gpt-6.1-sol",
	api: "openai-responses",
};

test("Xingchi Responses models receive the Fast tier", () => {
	assert.equal(supportsFastMode(xingchiModel), true);
	assert.deepEqual(
		applyFastMode({ model: xingchiModel.id, stream: true }, xingchiModel),
		{ model: xingchiModel.id, stream: true, service_tier: "fast" },
	);
});

test("Codex Pool uses Priority only on its Responses transport", () => {
	const model = { provider: "codex-pool", id: "gpt-6.2-sol", api: "openai-codex-responses" };
	const input = { stream: true };
	assert.equal(supportsFastMode(model), true);
	assert.deepEqual(applyFastMode(input, model), { stream: true, service_tier: "priority" });
	assert.deepEqual(input, { stream: true });
	for (const api of [undefined, "openai-completions", "openai-responses"]) {
		assert.equal(supportsFastMode({ ...model, api }), false);
		assert.equal(applyFastMode(input, { ...model, api }), input);
	}
	assert.equal(supportsFastMode({ ...model, id: "unknown-model" }), false);
});

test("Fast mode keeps provider and API guards", () => {
	assert.equal(supportsFastMode({ ...xingchiModel, api: "openai-completions" }), false);
	assert.equal(supportsFastMode({ ...xingchiModel, id: "unknown-model" }), false);
	assert.equal(supportsFastMode({ ...xingchiModel, provider: "other" }), false);
	assert.equal(
		(applyFastMode(
			{},
			{ provider: "openai", id: "gpt-6.1-sol", api: "openai-responses" },
			true,
		) as { service_tier?: unknown }).service_tier,
		"priority",
	);
});

test("/fast updates footer status across toggles, model changes and shutdown", async () => {
	const events = new Map<string, (event: any, ctx: any) => unknown>();
	const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
	const statuses = new Map<string, string | undefined>();
	const notices: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		model: xingchiModel,
		modelRegistry: {},
		ui: {
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			notify: (message: string) => notices.push(message),
		},
	} as unknown as ExtensionContext;

	registerFastMode({
		on: (name: string, handler: (event: any, context: any) => unknown) => events.set(name, handler),
		registerCommand: (name: string, command: { handler(args: string, context: any): Promise<void> }) =>
			commands.set(name, command),
		registerShortcut: () => undefined,
	} as unknown as ExtensionAPI);

	await events.get("model_select")!({}, ctx);
	assert.equal(statuses.get("pi-pulse-fast"), "Fast: OFF");
	await commands.get("fast")!.handler("on", ctx);
	assert.equal(statuses.get("pi-pulse-fast"), "Fast: ON");
	const rewritten = await events.get("before_provider_request")!({ payload: { stream: true } }, ctx);
	assert.deepEqual(rewritten, { stream: true, service_tier: "fast" });
	assert.equal(notices.at(-1)?.startsWith("Fast mode enabled"), true);

	const unsupported = { ...ctx, model: { ...xingchiModel, provider: "other" } } as unknown as ExtensionContext;
	await events.get("model_select")!({}, unsupported);
	assert.equal(statuses.get("pi-pulse-fast"), "Fast: unavailable");
	await commands.get("fast")!.handler("on", unsupported);
	assert.equal(statuses.get("pi-pulse-fast"), "Fast: unavailable");
	assert.equal(await events.get("before_provider_request")!({}, unsupported), undefined);
	await events.get("model_select")!({}, ctx);
	assert.equal(statuses.get("pi-pulse-fast"), "Fast: ON");
	await commands.get("fast")!.handler("off", ctx);
	assert.equal(statuses.get("pi-pulse-fast"), "Fast: OFF");
	const rpc = { ...ctx, mode: "rpc" } as ExtensionContext;
	await commands.get("fast")!.handler("on", rpc);
	assert.equal(statuses.get("pi-pulse-fast"), "Fast: OFF");
	await events.get("model_select")!({}, ctx);
	assert.equal(statuses.get("pi-pulse-fast"), "Fast: ON");
	await events.get("session_shutdown")!({}, ctx);
	assert.equal(statuses.get("pi-pulse-fast"), undefined);
});
