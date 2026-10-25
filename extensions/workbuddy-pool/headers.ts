import { createHash, randomBytes } from "node:crypto";
import { accountBase, originFor, type WbAccount } from "./store.ts";

export const CLIENT_VERSION = "5.5.4";
export const CLI_VERSION = "2.137.1";

export interface ChatMeta {
  conversationId: string;
  conversationRequestId: string;
  messageId: string;
}

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export function newChatMeta(conversationId?: string): ChatMeta {
  const requestId = newId();
  return { conversationId: conversationId || newId(), conversationRequestId: requestId, messageId: newId() };
}

/**
 * Stable per-account device fingerprint. Upstream correlates accounts by device
 * headers, so the value must be identical across restarts and differ per uid.
 */
export function stableAccountId(uid: string, purpose: "machine" | "session"): string {
  return createHash("sha256").update(`wb2a:${purpose}:${uid}`).digest("hex").slice(0, 36);
}

export function userAgent(account: WbAccount): string {
  const platform = account.realm === "global" ? "WorkBuddy AI" : "WorkBuddy";
  return `WorkBuddy/${CLIENT_VERSION} ${platform}/${CLIENT_VERSION} CLI/${CLI_VERSION}`;
}

function commonHeaders(account: WbAccount): Record<string, string> {
  const origin = originFor(account);
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: `${origin}/`,
    "User-Agent": userAgent(account),
    "X-CodeBuddy-Request": "1",
    "Accept-Language": account.realm === "global" ? "en-US" : "zh-CN",
    "X-Machine-ID": stableAccountId(account.uid, "machine"),
    "X-Session-ID": stableAccountId(account.uid, "session"),
  };
}

export function chatHeaders(account: WbAccount, meta: ChatMeta): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(account),
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${account.accessToken}`,
    "X-User-Id": account.uid,
  };
  if (account.realm === "global") {
    headers["X-No-Enterprise-Id"] = "1";
    headers["X-Domain"] = "www.workbuddy.ai";
  } else {
    headers["X-No-Enterprise-Id"] = "1";
    if (account.domain) headers["X-Domain"] = account.domain;
    else headers["X-No-Department-Info"] = "1";
  }
  // Usage attribution: upstream treats requests without these as gateway traffic.
  headers["X-Agent-Purpose"] = "conversation";
  headers["X-IDE-Name"] = "WorkBuddy";
  headers["X-IDE-Type"] = "WorkBuddy";
  headers["X-IDE-Version"] = CLIENT_VERSION;
  headers["X-Product"] = "WorkBuddy";
  if (account.deviceToken) headers["X-Device-Token"] = account.deviceToken;

  headers["X-Conversation-ID"] = meta.conversationId;
  headers["X-Conversation-Request-ID"] = meta.conversationRequestId;
  headers["X-Conversation-Message-ID"] = meta.messageId;
  headers["X-Request-ID"] = meta.messageId;
  headers["X-Root-Request-ID"] = meta.conversationRequestId;
  headers["X-Trace-ID"] = meta.conversationRequestId;
  headers["X-B3-TraceId"] = meta.conversationRequestId;
  headers["X-B3-SpanId"] = meta.messageId.slice(0, 16);
  headers["X-B3-Sampled"] = "1";
  return headers;
}

export function billingHeaders(account: WbAccount): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${account.accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-CodeBuddy-Request": "1",
    "Accept-Language": account.realm === "global" ? "en-US" : "zh-CN",
    "User-Agent": `WorkBuddy/${CLIENT_VERSION}`,
    "X-User-Id": account.uid,
  };
  if (account.domain) headers["X-Domain"] = account.domain;
  if (account.deviceToken) headers["X-Device-Token"] = account.deviceToken;
  return headers;
}

export function refreshHeaders(account: WbAccount): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(account),
    "X-Refresh-Token": account.refreshToken,
    "X-Auth-Refresh-Source": "plugin",
  };
  return headers;
}

export function loginHeaders(): Record<string, string> {
  const base = "https://www.workbuddy.ai";
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Origin: base,
    Referer: `${base}/`,
    "User-Agent": `WorkBuddy/${CLIENT_VERSION} WorkBuddy AI/${CLIENT_VERSION} CLI/${CLI_VERSION}`,
    "X-CodeBuddy-Request": "1",
    "Accept-Language": "en-US",
  };
}

export function url(path: string, account?: WbAccount): string {
  return `${account ? accountBase(account) : "https://www.workbuddy.ai"}${path}`;
}
