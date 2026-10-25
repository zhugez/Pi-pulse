import { wbFetch } from "./nodefetch.ts";
import { billingHeaders } from "./headers.ts";
import { accountBase, type WbAccount } from "./store.ts";

interface CreditPackage {
  CapacityRemain?: number;
  CapacityUsed?: number;
  PackageName?: string;
  CycleEndTime?: string;
}

interface CreditEnvelope {
  code?: unknown;
  data?: { Response?: { Data?: { Accounts?: CreditPackage[]; TotalDosage?: number } } };
}

export interface CreditSummary {
  remaining: number;
  used: number;
  packages: number;
  cycleEnd?: string;
}

function creditPath(account: WbAccount): string {
  return account.realm === "global" ? "/billing/meter/get-user-resource" : "/v2/billing/meter/get-user-resource";
}

export async function fetchCredit(account: WbAccount, signal?: AbortSignal): Promise<CreditSummary> {
  const response = await wbFetch()(`${accountBase(account)}${creditPath(account)}`, {
    method: "POST",
    headers: billingHeaders(account),
    body: "{}",
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`WorkBuddy credit lookup failed: HTTP ${response.status} ${text.slice(0, 160)}`);
  const parsed = JSON.parse(text) as CreditEnvelope;
  const packages = parsed.data?.Response?.Data?.Accounts ?? [];
  let remaining = 0;
  let used = 0;
  let cycleEnd: string | undefined;
  for (const item of packages) {
    remaining += item.CapacityRemain ?? 0;
    used += item.CapacityUsed ?? 0;
    if (item.CycleEndTime && (!cycleEnd || item.CycleEndTime > cycleEnd)) cycleEnd = item.CycleEndTime;
  }
  return { remaining, used, packages: packages.length, cycleEnd };
}

/** Daily check-in: upstream credits a small daily allowance per account. */
export async function dailyCheckin(account: WbAccount, signal?: AbortSignal): Promise<string> {
  const path = account.realm === "global" ? "/billing/meter/daily-checkin" : "/v2/billing/meter/daily-checkin";
  const response = await wbFetch()(`${accountBase(account)}${path}`, {
    method: "POST",
    headers: billingHeaders(account),
    body: "{}",
    signal,
  });
  const text = await response.text();
  if (!response.ok) return `HTTP ${response.status}: ${text.slice(0, 120)}`;
  try {
    const parsed = JSON.parse(text) as { code?: unknown; msg?: string };
    return parsed.code === 0 ? "checked in" : `not credited (${parsed.msg ?? parsed.code})`;
  } catch {
    return text.slice(0, 120);
  }
}
