// The approval token the in-app door hands the page with a needs_approval
// event and verifies when the page sends the approved call back. It binds
// the person, the organisation, the event, the tool and the exact input,
// and lives ten minutes, so an approval cannot be replayed for a different
// call, by a different person, or after the moment has passed. Same HMAC
// shape as the mobile JWT (src/lib/mobile-jwt.ts).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

export const APPROVAL_TOKEN_TTL_SECONDS = 10 * 60;

export interface ApprovalSubject {
  userId: string;
  organizationId: string;
  eventId: string | null;
  toolName: string;
  input: Record<string, unknown>;
}

interface ApprovalPayload {
  v: 1;
  userId: string;
  organizationId: string;
  eventId: string | null;
  toolName: string;
  /** SHA-256 of the canonical input, so the token names one exact call. */
  inputHash: string;
  exp: number;
  jti: string;
}

function getSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not set");
  return secret;
}

/** Key order must not matter: the page sends back what it was given. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashApprovalInput(input: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function sign(body: string): string {
  return createHmac("sha256", getSecret()).update(body).digest("base64url");
}

export function mintApprovalToken(subject: ApprovalSubject, now = Date.now()): { token: string; expiresAt: string } {
  const exp = Math.floor(now / 1000) + APPROVAL_TOKEN_TTL_SECONDS;
  const payload: ApprovalPayload = {
    v: 1,
    userId: subject.userId,
    organizationId: subject.organizationId,
    eventId: subject.eventId,
    toolName: subject.toolName,
    inputHash: hashApprovalInput(subject.input),
    exp,
    jti: randomBytes(8).toString("hex"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${body}.${sign(body)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export type ApprovalVerdict =
  | { ok: true }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "mismatch" };

/** Verifies the signature first, then the expiry, then that the token names exactly this call. */
export function verifyApprovalToken(token: string, subject: ApprovalSubject, now = Date.now()): ApprovalVerdict {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, signature] = parts;
  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature" };

  let payload: ApprovalPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString()) as ApprovalPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.v !== 1 || typeof payload.exp !== "number") return { ok: false, reason: "malformed" };
  if (payload.exp * 1000 <= now) return { ok: false, reason: "expired" };
  const matches =
    payload.userId === subject.userId &&
    payload.organizationId === subject.organizationId &&
    (payload.eventId ?? null) === (subject.eventId ?? null) &&
    payload.toolName === subject.toolName &&
    payload.inputHash === hashApprovalInput(subject.input);
  return matches ? { ok: true } : { ok: false, reason: "mismatch" };
}
