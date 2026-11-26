import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_KEYS = ["pi-pulse-fast", "pi-fast"] as const;

/**
 * Read the local opt-in without requiring a separate settings file. The
 * `pi-fast` key remains a compatibility alias for existing user settings.
 */
export async function isFastModeEnabledByDefault(
	settingsPath = join(getAgentDir(), "settings.json"),
): Promise<boolean> {
	try {
		const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
		if (!isRecord(parsed)) return false;

		return SETTINGS_KEYS.some((key) => {
			const settings = parsed[key];
			return isRecord(settings) && settings.enabledByDefault === true;
		});
	} catch (error) {
		if (error instanceof SyntaxError || isMissingFileError(error)) return false;
		throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}
