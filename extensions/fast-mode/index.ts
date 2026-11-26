import { Key } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isFastModeEnabledByDefault } from "./config.ts";
import { applyFastMode, supportsFastMode } from "./fast-mode.ts";

const STATUS_KEY = "pi-pulse-fast";
const STATUS_ICONS = {
	on: "\u{f0241}",
	off: "\u{f06d5}",
	unavailable: "\u{f0243}",
} as const;

type Toggle = "on" | "off" | "toggle";

export default function registerFastMode(pi: ExtensionAPI): void {
	let enabled = false;

	function isUsingOAuth(ctx: ExtensionContext): boolean {
		if (ctx.model?.provider !== "openai") return false;
		const registry = ctx.modelRegistry as typeof ctx.modelRegistry & {
			isUsingOAuth?: (model: typeof ctx.model) => boolean;
		};
		return registry.isUsingOAuth?.(ctx.model) === true;
	}

	function rewritePayload(payload: unknown, ctx: ExtensionContext): unknown {
		return applyFastMode(payload, ctx.model, isUsingOAuth(ctx));
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		const supported = supportsFastMode(ctx.model);
		const icon = !supported
			? STATUS_ICONS.unavailable
			: enabled
				? STATUS_ICONS.on
				: STATUS_ICONS.off;
		ctx.ui.setStatus(STATUS_KEY, icon);
	}

	function notify(
		ctx: ExtensionContext,
		message: string,
		type: "info" | "warning",
	): void {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	}

	function setEnabled(next: boolean, ctx: ExtensionContext): void {
		if (next && !supportsFastMode(ctx.model)) {
			notify(ctx, "Fast mode is unavailable for the current provider/model.", "warning");
			updateStatus(ctx);
			return;
		}

		enabled = next;
		updateStatus(ctx);
		notify(
			ctx,
			next
				? "Fast mode enabled; requests ask for Fast processing, which can increase API charges or subscription usage."
				: "Fast mode disabled.",
			next ? "warning" : "info",
		);
	}

	function toggle(ctx: ExtensionContext): void {
		setEnabled(!enabled, ctx);
	}

	pi.registerCommand("fast", {
		description: "Toggle Fast mode for supported provider/models",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase() as Toggle | "";
			if (mode === "on") return setEnabled(true, ctx);
			if (mode === "off") return setEnabled(false, ctx);
			if (mode === "" || mode === "toggle") return toggle(ctx);
			notify(ctx, "Usage: /fast [on|off|toggle]", "warning");
		},
	});

	pi.registerShortcut(Key.ctrlShift("r"), {
		description: "Toggle Fast mode",
		handler: toggle,
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !supportsFastMode(ctx.model)) return;
		return rewritePayload(event.payload, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled = await isFastModeEnabledByDefault();
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});
}

export { applyFastMode, supportsFastMode } from "./fast-mode.ts";
