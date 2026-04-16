/**
 * SSRF-safe fetch helpers for outbound HTTP(S) requests initiated from
 * agent/MCP tool calls or other user-driven flows.
 *
 * Blocks private/reserved IP ranges (including EC2 IMDS at 169.254.169.254,
 * GCP/Azure/Alibaba metadata hostnames), rejects non-http(s) schemes + URLs
 * with embedded credentials, and re-validates every redirect hop.
 *
 * TOCTOU note: DNS resolution happens before the actual fetch, so a DNS
 * rebind could theoretically race the validation. We log resolved IPs so
 * post-hoc auditing is possible; a follow-up can wire a custom http.Agent
 * with a lookup callback that re-checks at socket creation.
 */
import { lookup as dnsLookup } from "dns/promises";
import { BlockList, isIPv4, isIPv6 } from "net";
import { apiLogger } from "./logger";

export type SafeFetchReason =
  | "invalid_url"
  | "scheme_blocked"
  | "dns_failed"
  | "ip_blocked"
  | "timeout"
  | "too_large"
  | "http_error"
  | "bad_content_type"
  | "too_many_redirects";

export type SafeFetchResult<T> =
  | { ok: true; data: T; finalUrl: string; contentType?: string }
  | { ok: false; reason: SafeFetchReason; detail?: string; finalUrl?: string };

const BLOCKED_HOSTNAMES = new Set<string>([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "metadata.packet.net",
  "169.254.169.254",
  "fd00:ec2::254",
  "100.100.100.200",
]);

const IMAGE_EXT_BY_MIME: Record<string, "jpg" | "png" | "webp" | "svg"> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const ipv4BlockList = new BlockList();
ipv4BlockList.addSubnet("0.0.0.0", 8, "ipv4");
ipv4BlockList.addSubnet("10.0.0.0", 8, "ipv4");
ipv4BlockList.addSubnet("100.64.0.0", 10, "ipv4");
ipv4BlockList.addSubnet("127.0.0.0", 8, "ipv4");
ipv4BlockList.addSubnet("169.254.0.0", 16, "ipv4");
ipv4BlockList.addSubnet("172.16.0.0", 12, "ipv4");
ipv4BlockList.addSubnet("192.0.0.0", 24, "ipv4");
ipv4BlockList.addSubnet("192.0.2.0", 24, "ipv4");
ipv4BlockList.addSubnet("192.168.0.0", 16, "ipv4");
ipv4BlockList.addSubnet("198.18.0.0", 15, "ipv4");
ipv4BlockList.addSubnet("198.51.100.0", 24, "ipv4");
ipv4BlockList.addSubnet("203.0.113.0", 24, "ipv4");
ipv4BlockList.addSubnet("224.0.0.0", 4, "ipv4");
ipv4BlockList.addSubnet("240.0.0.0", 4, "ipv4");
ipv4BlockList.addAddress("255.255.255.255", "ipv4");

const ipv6BlockList = new BlockList();
ipv6BlockList.addAddress("::1", "ipv6");
ipv6BlockList.addSubnet("fc00::", 7, "ipv6");
ipv6BlockList.addSubnet("fe80::", 10, "ipv6");
ipv6BlockList.addSubnet("2001:db8::", 32, "ipv6");
ipv6BlockList.addSubnet("ff00::", 8, "ipv6");

export function isPrivateOrReservedIp(ip: string): boolean {
  const trimmed = ip.trim();
  if (!trimmed) return true;
  if (isIPv4(trimmed)) return ipv4BlockList.check(trimmed, "ipv4");
  if (isIPv6(trimmed)) {
    // Handle IPv4-mapped IPv6 addresses (::ffff:a.b.c.d)
    const mappedMatch = /^::ffff:([0-9.]+)$/i.exec(trimmed);
    if (mappedMatch && isIPv4(mappedMatch[1])) {
      return ipv4BlockList.check(mappedMatch[1], "ipv4");
    }
    return ipv6BlockList.check(trimmed, "ipv6");
  }
  return true;
}

export class UnsafeUrlError extends Error {
  constructor(public reason: SafeFetchReason, message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid_url", `Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("scheme_blocked", `Rejected URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("scheme_blocked", "URL must not contain embedded credentials");
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new UnsafeUrlError("ip_blocked", `Hostname ${host} is on the cloud-metadata block list`);
  }
  return url;
}

async function resolveAndCheckHost(url: URL): Promise<{ ok: true; addresses: string[] } | { ok: false; reason: SafeFetchReason; detail?: string }> {
  const host = url.hostname;
  // If the hostname is already a literal IP, just validate it.
  if (isIPv4(host) || isIPv6(host)) {
    if (isPrivateOrReservedIp(host)) {
      return { ok: false, reason: "ip_blocked", detail: `Literal IP ${host} is private/reserved` };
    }
    return { ok: true, addresses: [host] };
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dnsLookup(host, { all: true, verbatim: true });
  } catch (err) {
    return { ok: false, reason: "dns_failed", detail: err instanceof Error ? err.message : String(err) };
  }
  const addresses = records.map((r) => r.address);
  if (addresses.length === 0) {
    return { ok: false, reason: "dns_failed", detail: "No A/AAAA records" };
  }
  for (const addr of addresses) {
    if (isPrivateOrReservedIp(addr)) {
      return { ok: false, reason: "ip_blocked", detail: `${host} resolved to ${addr}` };
    }
  }
  return { ok: true, addresses };
}

interface FetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  accept: string;
}

const HTML_DEFAULTS: FetchOptions = {
  maxBytes: 1_000_000,
  timeoutMs: 8000,
  maxRedirects: 3,
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
};

const IMAGE_DEFAULTS: FetchOptions = {
  maxBytes: 1_048_576,
  timeoutMs: 8000,
  maxRedirects: 2,
  accept: "image/*;q=0.9,*/*;q=0.5",
};

const USER_AGENT = "ea-sys-research/1.0 (+https://events.meetingmindsgroup.com)";

async function readLimitedBody(res: Response, maxBytes: number): Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: SafeFetchReason }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.arrayBuffer();
    if (text.byteLength > maxBytes) return { ok: false, reason: "too_large" };
    return { ok: true, buffer: Buffer.from(text) };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("aborted") || message.includes("timeout")) {
      return { ok: false, reason: "timeout" };
    }
    throw err;
  }
  return { ok: true, buffer: Buffer.concat(chunks, total) };
}

async function performSafeFetch(rawUrl: string, opts: FetchOptions): Promise<SafeFetchResult<{ buffer: Buffer; contentType?: string }>> {
  let currentUrl: URL;
  try {
    currentUrl = assertSafeUrl(rawUrl);
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return { ok: false, reason: err.reason, detail: err.message };
    }
    return { ok: false, reason: "invalid_url", detail: err instanceof Error ? err.message : String(err) };
  }

  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const check = await resolveAndCheckHost(currentUrl);
    if (!check.ok) {
      return { ok: false, reason: check.reason, detail: check.detail, finalUrl: currentUrl.toString() };
    }
    apiLogger.debug({
      msg: "safe-fetch:resolved",
      host: currentUrl.hostname,
      addresses: check.addresses,
      hop,
    });

    let res: Response;
    try {
      res = await fetch(currentUrl.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          "User-Agent": USER_AGENT,
          Accept: opts.accept,
          "Accept-Language": "en;q=0.9",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("aborted") || err instanceof DOMException) {
        return { ok: false, reason: "timeout", detail: message, finalUrl: currentUrl.toString() };
      }
      return { ok: false, reason: "http_error", detail: message, finalUrl: currentUrl.toString() };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        return { ok: false, reason: "http_error", detail: `Redirect ${res.status} missing Location header`, finalUrl: currentUrl.toString() };
      }
      if (hop >= opts.maxRedirects) {
        return { ok: false, reason: "too_many_redirects", finalUrl: currentUrl.toString() };
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        return { ok: false, reason: "invalid_url", detail: `Bad redirect target: ${location}`, finalUrl: currentUrl.toString() };
      }
      try {
        currentUrl = assertSafeUrl(next.toString());
      } catch (err) {
        if (err instanceof UnsafeUrlError) {
          return { ok: false, reason: err.reason, detail: err.message, finalUrl: next.toString() };
        }
        return { ok: false, reason: "invalid_url", finalUrl: next.toString() };
      }
      continue;
    }

    if (!res.ok) {
      return { ok: false, reason: "http_error", detail: `HTTP ${res.status}`, finalUrl: currentUrl.toString() };
    }

    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? undefined;
    const body = await readLimitedBody(res, opts.maxBytes);
    if (!body.ok) {
      return { ok: false, reason: body.reason, finalUrl: currentUrl.toString() };
    }
    return { ok: true, data: { buffer: body.buffer, contentType }, finalUrl: currentUrl.toString(), contentType };
  }

  return { ok: false, reason: "too_many_redirects" };
}

export async function safeFetchHtml(
  url: string,
  overrides: Partial<FetchOptions> = {}
): Promise<SafeFetchResult<string>> {
  const opts = { ...HTML_DEFAULTS, ...overrides };
  const result = await performSafeFetch(url, opts);
  if (!result.ok) return result;
  const ct = result.contentType ?? "";
  if (ct && !ct.startsWith("text/html") && !ct.startsWith("application/xhtml+xml")) {
    return { ok: false, reason: "bad_content_type", detail: ct, finalUrl: result.finalUrl };
  }
  const text = result.data.buffer.toString("utf8");
  return { ok: true, data: text, finalUrl: result.finalUrl, contentType: ct };
}

export async function safeFetchImage(
  url: string,
  overrides: Partial<FetchOptions> = {}
): Promise<SafeFetchResult<{ buffer: Buffer; ext: "jpg" | "png" | "webp" | "svg"; mime: string }>> {
  const opts = { ...IMAGE_DEFAULTS, ...overrides };
  const result = await performSafeFetch(url, opts);
  if (!result.ok) return result;
  const ct = result.contentType ?? "";
  const ext = IMAGE_EXT_BY_MIME[ct];
  if (!ext) {
    return { ok: false, reason: "bad_content_type", detail: ct, finalUrl: result.finalUrl };
  }
  return {
    ok: true,
    data: { buffer: result.data.buffer, ext, mime: ct },
    finalUrl: result.finalUrl,
    contentType: ct,
  };
}
