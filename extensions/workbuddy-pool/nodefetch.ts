import { lookup as systemLookup, Resolver } from "node:dns";
import { request } from "node:https";
import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * fetch() on top of node:https with a resolver fallback.
 *
 * Two reasons not to use global fetch:
 *  - the WSL/system resolver can be down while public DNS still answers, which is
 *    exactly the case the panel solves with its own `dns_servers`;
 *  - WorkBuddy needs request headers the platform fetch layer does not touch, and a
 *    plain https client keeps full control over them.
 */
const FALLBACK_SERVERS = ["1.1.1.1", "8.8.8.8"];

type LookupCallback = (error: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;

/** net.connect asks for an address array when `options.all` is set. */
function answer(options: unknown, callback: LookupCallback, address: string, family: number): void {
  if ((options as { all?: boolean } | undefined)?.all) callback(null, [{ address, family }]);
  else callback(null, address, family);
}

function fallbackLookup(servers: string[]) {
  const resolver = new Resolver();
  resolver.setServers(servers);
  return (hostname: string, options: unknown, callback: LookupCallback): void => {
    resolver.resolve4(hostname, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      if (!addresses || addresses.length === 0) {
        const notFound = new Error(`no address for ${hostname}`) as NodeJS.ErrnoException;
        notFound.code = "ENOTFOUND";
        callback(notFound);
        return;
      }
      answer(options, callback, addresses[0], 4);
    });
  };
}

/**
 * System resolver first, public resolvers when it fails or stalls. A dead WSL/sandbox
 * resolver can hang for tens of seconds, so the system attempt is time-boxed.
 */
export function resilientLookup(servers: string[] = FALLBACK_SERVERS, systemBudgetMs = 1_500) {
  const fallback = fallbackLookup(servers);
  return (hostname: string, options: unknown, callback: LookupCallback): void => {
    let settled = false;
    const useFallback = () => {
      if (settled) return;
      settled = true;
      fallback(hostname, options, callback);
    };
    const timer = setTimeout(useFallback, systemBudgetMs);
    timer.unref?.();
    systemLookup(hostname, options as never, (error, address, family) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error && address) {
        // dns.lookup already returns an address list when `all` is requested.
        if (Array.isArray(address)) callback(null, address);
        else answer(options, callback, address, family ?? 4);
      }
      else fallback(hostname, options, callback);
    });
  };
}

export interface NodeFetchOptions {
  dnsServers?: string[];
  timeoutMs?: number;
}

function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
  }
  return headers;
}

export function createNodeFetch(options: NodeFetchOptions = {}): FetchFunction {
  const lookup = resilientLookup(options.dnsServers);
  const timeoutMs = options.timeoutMs ?? 300_000;

  const nodeFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
    const target = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const source = init.headers instanceof Headers ? init.headers : new Headers(init.headers as never);
      source.forEach((value, key) => { headers[key] = value; });
    }
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) {
      reject(new Error("request aborted"));
      return;
    }
    const req = request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: init?.method ?? "GET",
      headers: body ? { ...headers, "content-length": String(Buffer.byteLength(body)) } : headers,
      lookup: lookup as never,
      servername: target.hostname,
    }, (res) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          res.on("end", () => controller.close());
          res.on("error", (error) => controller.error(error));
        },
        cancel() {
          res.destroy();
        },
      });
      resolve(new Response(stream, { status: res.statusCode ?? 502, headers: toHeaders(res.headers) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("WorkBuddy request timed out")));
    req.on("error", reject);
    if (signal) signal.addEventListener("abort", () => req.destroy(new Error("request aborted")), { once: true });
    if (body) req.write(body);
    req.end();
  });

  return nodeFetch as FetchFunction;
}

let shared: FetchFunction | undefined;

/** Process-wide client: one resolver instance, reused by every WorkBuddy call. */
export function wbFetch(): FetchFunction {
  if (process.platform === "win32") return globalThis.fetch as FetchFunction;
  shared ??= createNodeFetch();
  return shared;
}
