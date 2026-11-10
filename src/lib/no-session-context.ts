/**
 * What a "no session" 401 warning can safely say about the request, so an
 * expired tab can be told from a session fault (production audit, Nov 10,
 * 2026: staff requests arrived with no recognised session seconds after a
 * successful sign-in, and the warning lines carried nothing to tell why).
 *
 * The line to read first is `hasSessionCookie`: false means the browser sent
 * no session at all (signed out, expired, another host); true means a cookie
 * arrived and was not accepted, which is the fault worth chasing. Only that
 * boolean is logged, NEVER the cookie's value.
 *
 * Never throws: this only decorates a warning, so outside a request (a unit
 * test, a script) it answers `{ requestContext: "unavailable" }`.
 */
import { headers } from "next/headers";
import { getClientIp } from "@/lib/security";

const USER_AGENT_MAX = 200;

// NextAuth v5 names the cookie `authjs.session-token`, with `__Secure-` in
// front on https and `.0`, `.1`... behind when the token is split into chunks.
// The v4 name is matched too: a browser may still hold one.
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-|__Host-)?(?:authjs|next-auth)\.session-token(?:\.\d+)?=/;

export type NoSessionContext =
  | {
      host: string | null;
      hasSessionCookie: boolean;
      userAgent: string | null;
      prefetch: boolean;
      rsc: boolean;
      purposePrefetch: boolean;
      ip: string;
    }
  | { requestContext: "unavailable" };

function fromHeaders(h: Headers): NoSessionContext {
  const purpose = `${h.get("purpose") ?? ""} ${h.get("sec-purpose") ?? ""}`;
  return {
    // nginx forwards the public name; the bare Host is the fallback.
    host: h.get("x-forwarded-host") ?? h.get("host"),
    hasSessionCookie: SESSION_COOKIE.test(h.get("cookie") ?? ""),
    userAgent: h.get("user-agent")?.slice(0, USER_AGENT_MAX) ?? null,
    prefetch: h.has("next-router-prefetch"),
    rsc: h.has("rsc"),
    purposePrefetch: /prefetch/i.test(purpose),
    // getClientIp reads only the headers.
    ip: getClientIp({ headers: h } as Request),
  };
}

/** For a handler that has the Request in hand. */
export function noSessionContext(req: Request): NoSessionContext {
  try {
    return fromHeaders(req.headers);
  } catch {
    return { requestContext: "unavailable" };
  }
}

/** For a guard, page or layout with no Request: reads `next/headers`. */
export async function noSessionContextFromHeaders(): Promise<NoSessionContext> {
  try {
    return fromHeaders(await headers());
  } catch {
    return { requestContext: "unavailable" };
  }
}
