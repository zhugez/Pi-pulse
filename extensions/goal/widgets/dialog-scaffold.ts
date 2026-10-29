/**
 * Shared bordered-dialog scaffold (P1-11): the line/horiz/inner-width helpers
 * were copy-pasted across the escape dialog, the task-list confirmation
 * dialog, and the task-list overlay. Collapsed here with byte-identical
 * output; the renderers above these helpers keep their own headers, options,
 * and footers.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Inner content width between the ││ borders for a dialog at termWidth. */
export function dialogInnerWidth(termWidth: number, maxInner = 64): number {
	return Math.min(termWidth, maxInner) - 2;
}

/** One bordered line: exactly innerWidth visible chars between ││. */
export function borderedLine(accent: (s: string) => string, innerWidth: number, content: string): string {
	const fitted = truncateToWidth(content, innerWidth, "…");
	const fill = innerWidth - visibleWidth(fitted);
	return accent("│") + fitted + " ".repeat(Math.max(0, fill)) + accent("│");
}

/** The ── run used by ┌/├/└ borders. */
export function horizontalRule(innerWidth: number): string {
	return "─".repeat(innerWidth);
}
