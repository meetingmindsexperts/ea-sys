/**
 * The OAuth `state` for the QuickBooks connect flow (September 22, 2026).
 *
 * Intuit hands `state` back on the redirect, so it is the only thing tying
 * the callback to the person who started it. Without a signed one, anybody
 * could walk a signed-in admin's browser onto our callback and attach THEIR
 * QuickBooks company to OUR organisation. Same HMAC shape as the agent's
 * approval token: it binds the organisation and the person, and expires.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const CONNECT_STATE_TTL_SECONDS = 10 * 60;

interface StatePayload {
  v: 1;
  organizationId: string;
  userId: string;
  exp: number;
  jti: string;
}

function secret(): string {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("NEXTAUTH_SECRET is not set");
  return s;
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

export function mintConnectState(subject: { organizationId: string; userId: string }, now = Date.now()): string {
  const payload: StatePayload = {
    v: 1,
    organizationId: subject.organizationId,
    userId: subject.userId,
    exp: Math.floor(now / 1000) + CONNECT_STATE_TTL_SECONDS,
    jti: randomBytes(9).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export type StateVerdict =
  | { ok: true; organizationId: string; userId: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyConnectState(token: string, now = Date.now()): StateVerdict {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, signature] = parts;

  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload?.v !== 1 || !payload.organizationId || !payload.userId || typeof payload.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, organizationId: payload.organizationId, userId: payload.userId };
}
