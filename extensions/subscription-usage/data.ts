/** Validated usage payload shared by providers, rendering, and persistence. */
export interface UsageBalance {
	currency: string;
	total: number;
}

export interface AccountUsageItem {
	id: string;
	active?: boolean;
	cooldown?: boolean;
	plan?: string;
	windows: Record<string, number>;
	resets?: Record<string, number>;
}

export interface UsageData {
	windows: Record<string, number>;
	plan?: string;
	resets?: Record<string, number>;
	balance?: UsageBalance;
	resetsLeft?: number;
	accounts?: AccountUsageItem[];
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizePercent(value: unknown): number | undefined {
	const percent = finiteNumber(value);
	return percent === undefined ? undefined : Math.min(100, Math.max(0, percent));
}

function normalizeResets(value: unknown): Record<string, number> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const entries = Object.entries(record).flatMap(([key, reset]) => {
		const value = finiteNumber(reset);
		return value !== undefined && value >= 0 ? [[key, value] as const] : [];
	});
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeBalance(value: unknown): UsageBalance | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const currency =
		typeof record.currency === "string" ? record.currency.trim().toUpperCase() : "";
	const total = finiteNumber(record.total);
	if (!currency || total === undefined) return undefined;
	return { currency, total };
}

function normalizeResetsLeft(value: unknown): number | undefined {
	const count = finiteNumber(value);
	return count !== undefined && count >= 0 ? Math.floor(count) : undefined;
}

function normalizeAccounts(value: unknown): AccountUsageItem[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items: AccountUsageItem[] = [];
	for (const raw of value) {
		const rec = asRecord(raw);
		if (!rec || typeof rec.id !== "string" || !rec.id) continue;
		const winRecord = asRecord(rec.windows);
		if (!winRecord) continue;
		const windows = Object.fromEntries(
			Object.entries(winRecord).flatMap(([k, p]) => {
				const norm = normalizePercent(p);
				return norm === undefined ? [] : [[k, norm] as const];
			}),
		);
		const resets = normalizeResets(rec.resets);
		const plan = typeof rec.plan === "string" ? rec.plan.trim() : undefined;
		items.push({
			id: rec.id.trim(),
			active: Boolean(rec.active),
			cooldown: Boolean(rec.cooldown),
			...(plan ? { plan } : {}),
			windows,
			...(resets ? { resets } : {}),
		});
	}
	return items.length > 0 ? items : undefined;
}

/** Decode provider or disk-cache data before it reaches rendering or scheduling. */
export function normalizeUsageData(value: unknown): UsageData | undefined {
	const record = asRecord(value);
	const windowsRecord = asRecord(record?.windows);
	const balance = normalizeBalance(record?.balance);
	if (!windowsRecord && !balance) return undefined;

	const windows = windowsRecord
		? (Object.fromEntries(
				Object.entries(windowsRecord).flatMap(([key, percent]) => {
					const normalized = normalizePercent(percent);
					return normalized === undefined ? [] : [[key, normalized] as const];
				}),
			) as Record<string, number>)
		: {};
	const plan = typeof record?.plan === "string" ? record.plan.trim() : undefined;
	if (Object.keys(windows).length === 0 && !balance && !plan) return undefined;
	const resets = normalizeResets(record?.resets);
	const resetsLeft = normalizeResetsLeft(record?.resetsLeft);
	const accounts = normalizeAccounts(record?.accounts);
	return {
		windows,
		...(plan ? { plan } : {}),
		...(resets ? { resets } : {}),
		...(balance ? { balance } : {}),
		...(resetsLeft !== undefined ? { resetsLeft } : {}),
		...(accounts ? { accounts } : {}),
	};
}
