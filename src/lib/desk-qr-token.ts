// The desk QR token (docs/ONSITE_DESK_PLAN.md §8.4). The desk shows a QR for
// one of two free forms, exhibitors or complimentary, and the link carries
// this token. While it is valid the public register route relaxes four things
// for that event and that form only (§8.5); without it, or once it expires,
// the link is the ordinary public form. Signed, never stored. The desk shows
// ONE QR per event and kind, valid to the end of the event and printable
// (owner, Oct 29): minted with `until`, it is the same token every time it is
// shown, so a printed sheet and the screen match. Without `until` a token
// lives 30 minutes (DESK_QR_TTL_SECONDS). Same HMAC shape as the agent's approval
// token (src/lib/agent/approval-token.ts), with its own purpose label so one
// kind of token can never pass as the other.
//
// Server only (node:crypto).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

export const DESK_QR_TTL_SECONDS = 30 * 60;

export type DeskQrKind = "exhibitor" | "complimentary";

export interface DeskQrSubject {
  eventId: string;
  kind: DeskQrKind;
  /** The rate's slug (registerTierSlug): the only rate the form may use. */
  rate: string;
  /** A sponsor's code the form must use; null lets the person enter their own sponsor's. */
  promoCodeId: string | null;
  /** The staff member who showed the QR, for the audit row. */
  issuedBy: string;
}

export interface DeskQrPayload extends DeskQrSubject {
  v: 1;
  exp: number;
  /** One id per QR, for the per-QR rate limit and the audit row. */
  jti: string;
}

const PURPOSE = "desk-qr:v1";

function getSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not set");
  return secret;
}

function sign(body: string): string {
  return createHmac("sha256", getSecret()).update(`${PURPOSE}.${body}`).digest("base64url");
}

/**
 * A QR good for 30 minutes from `now`, or, with `until`, one good until then
 * whose id comes from what it is for: the same subject and `until` always give
 * the same token.
 */
export function mintDeskQrToken(
  subject: DeskQrSubject,
  now = Date.now(),
  until?: Date,
): { token: string; expiresAt: Date; jti: string } {
  const exp = until ? Math.floor(until.getTime() / 1000) : Math.floor(now / 1000) + DESK_QR_TTL_SECONDS;
  const jti = until
    ? createHash("sha256").update(`${subject.eventId}:${subject.kind}:${subject.rate}:${subject.promoCodeId ?? ""}:${exp}`).digest("hex").slice(0, 16)
    : randomBytes(8).toString("hex");
  const payload: DeskQrPayload = { v: 1, ...subject, exp, jti };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${body}.${sign(body)}`, expiresAt: new Date(exp * 1000), jti: payload.jti };
}

export type DeskQrVerdict =
  | { ok: true; payload: DeskQrPayload }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

function isKind(value: unknown): value is DeskQrKind {
  return value === "exhibitor" || value === "complimentary";
}

function readPayload(body: string): DeskQrPayload | null {
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as Partial<DeskQrPayload>;
    if (p.v !== 1 || typeof p.exp !== "number" || typeof p.eventId !== "string") return null;
    if (!isKind(p.kind) || typeof p.rate !== "string" || typeof p.jti !== "string" || typeof p.issuedBy !== "string") return null;
    return p as DeskQrPayload;
  } catch {
    return null;
  }
}

/**
 * The signature first, then the shape, then the expiry. The caller still
 * checks `payload.eventId` against the event it resolved: the register route
 * reads the token before it looks the event up, to choose its rate limit.
 */
export function verifyDeskQrToken(token: string, now = Date.now()): DeskQrVerdict {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, signature] = parts;
  const a = Buffer.from(signature);
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature" };
  const payload = readPayload(body);
  if (!payload) return { ok: false, reason: "malformed" };
  if (payload.exp * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
