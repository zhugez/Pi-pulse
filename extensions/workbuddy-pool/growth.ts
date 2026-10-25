import { wbFetch } from "./nodefetch.ts";
import { billingHeaders } from "./headers.ts";
import { accountBase, type WbAccount } from "./store.ts";

async function request<T>(account: WbAccount, path: string, method = "GET", body?: unknown, web = false, signal?: AbortSignal): Promise<T> {
  const base = web ? "https://www.workbuddy.cn" : accountBase(account);
  const headers = billingHeaders(account);
  if (web) {
    headers.Origin = "https://www.workbuddy.cn";
    headers.Referer = "https://www.workbuddy.cn/profile/growth-center";
    headers["x-client-platform"] = "web";
  }
  const response = await wbFetch()(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : {}; } catch { throw new Error(`WorkBuddy growth returned invalid JSON: ${text.slice(0, 160)}`); }
  if (!response.ok) throw new Error(`WorkBuddy growth HTTP ${response.status}: ${text.slice(0, 240)}`);
  if (parsed && typeof parsed === "object" && "code" in parsed && Number((parsed as { code?: unknown }).code) !== 0) {
    throw new Error(`WorkBuddy growth error ${(parsed as { msg?: unknown }).msg ?? (parsed as { code?: unknown }).code}`);
  }
  if (parsed && typeof parsed === "object" && "data" in parsed) return (parsed as { data: T }).data;
  return parsed as T;
}

export async function listTasks(account: WbAccount, signal?: AbortSignal): Promise<unknown> {
  return request(account, "/v2/activity/growth/tasks", "GET", undefined, false, signal);
}

export async function acceptTasks(account: WbAccount, taskCodes: string[], signal?: AbortSignal): Promise<unknown> {
  return request(account, "/v2/activity/growth/tasks/accept", "POST", { task_codes: taskCodes }, false, signal);
}

export async function claimTask(account: WbAccount, taskCode: string, signal?: AbortSignal): Promise<unknown> {
  return request(account, `/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`, "POST", undefined, true, signal);
}

export async function claimTrial(account: WbAccount, signal?: AbortSignal): Promise<unknown> {
  if (account.realm !== "global") throw new Error("trial is available only for global accounts");
  try { return await request(account, "/billing/ide/trial", "POST", undefined, false, signal); }
  catch (error) {
    if (/14051|already|已领取/i.test(error instanceof Error ? error.message : String(error))) return { alreadyClaimed: true };
    throw error;
  }
}

export async function streak(account: WbAccount, signal?: AbortSignal): Promise<unknown> {
  return request(account, "/activity/growth/streak", "GET", undefined, false, signal);
}

export async function redeemStreak(account: WbAccount, tier: "7d" | "14d" | "28d", signal?: AbortSignal): Promise<unknown> {
  return request(account, "/activity/growth/redeem", "POST", { tier, client_token: crypto.randomUUID() }, false, signal);
}

export async function lottery(account: WbAccount, signal?: AbortSignal): Promise<unknown> {
  return request(account, "/activity/growth/lottery/draw", "POST", { client_token: crypto.randomUUID() }, false, signal);
}

export async function travel(account: WbAccount, action: "status" | "depart" | "claim", value?: number, signal?: AbortSignal): Promise<unknown> {
  if (action === "status") return request(account, "/activity/growth/buddy/travel/status", "GET", undefined, false, signal);
  if (action === "depart") return request(account, "/activity/growth/buddy/travel/depart", "POST", { location_id: value }, false, signal);
  return request(account, "/activity/growth/buddy/travel/claim", "POST", { record_id: value }, false, signal);
}

export async function buddy(account: WbAccount, action: "info" | "first" | "agreement", signal?: AbortSignal): Promise<unknown> {
  if (action === "info") return request(account, "/activity/growth/buddy/info", "GET", undefined, false, signal);
  return request(account, `/activity/growth/buddy/${action}`, "POST", action === "agreement" ? { agree: true } : {}, false, signal);
}
