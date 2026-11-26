import { Key } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isFastModeEnabledByDefault } from "./config.ts";
import { applyFastMode, supportsFastMode } from "./fast-mode.ts";

const STATUS_KEY = "pi-pulse-fast";
type Toggle = "on" | "off" | "toggle";

export default function registerFastMode(pi: ExtensionAPI): void {
	let enabled = false;
	let dockAvailable = false;
	let lastCtx: ExtensionContext | undefined;
	let unsubscribeDock: (() => void) | undefined;
	let unsubscribeSnapshot: (() => void) | undefined;
	function subscribeDock(): void {
		unsubscribeDock?.();
		unsubscribeSnapshot?.();
		unsubscribeDock = pi.events?.on("pi-pulse:telemetry-dock:v1", (event: unknown) => {
			if (!event || typeof event !== "object" || !("available" in event) || typeof event.available !== "boolean" || event.available === dockAvailable) return;
			dockAvailable = event.available;
			if (lastCtx) updateStatus(lastCtx);
		});
		unsubscribeSnapshot = pi.events?.on("pi-pulse:telemetry-request:v1", () => { if (lastCtx) updateStatus(lastCtx); });
	}
	subscribeDock();


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
		lastCtx = ctx;
		const supported = supportsFastMode(ctx.model);
		const state = !supported ? "n/a" : enabled ? "on" : "off";
		const scope = `${ctx.sessionManager?.getSessionId?.() ?? ""}:${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
		pi.events?.emit("pi-pulse:telemetry:v1", { kind: "fast", scope, data: state });
		if (dockAvailable) { ctx.ui.setStatus(STATUS_KEY, undefined); return; }
		const { theme } = ctx.ui;
		ctx.ui.setStatus(STATUS_KEY, `${theme.fg("muted", "Fast")} ${theme.fg(state === "on" ? "success" : "dim", state)}`);
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
		subscribeDock();
		enabled = await isFastModeEnabledByDefault();
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeDock?.();
		unsubscribeSnapshot?.();
		lastCtx = undefined;
		pi.events?.emit("pi-pulse:telemetry:v1", { kind: "fast", scope: "", data: null });
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

export { applyFastMode, supportsFastMode } from "./fast-mode.ts";
