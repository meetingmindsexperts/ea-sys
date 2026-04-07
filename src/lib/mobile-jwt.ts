import { createHmac, randomBytes } from "crypto";

const ALG = "HS256";

interface MobileTokenPayload {
  userId: string;
  email: string;
  role: string;
  organizationId: string | null;
  organizationName: string | null;
  firstName: string;
  lastName: string;
}

interface DecodedMobileToken extends MobileTokenPayload {
  iat: number;
  exp: number;
  jti: string;
  type: "access" | "refresh";
}

// 24 hours for access tokens, 30 days for refresh tokens
const ACCESS_TOKEN_MAX_AGE = 24 * 60 * 60;
const REFRESH_TOKEN_MAX_AGE = 30 * 24 * 60 * 60;

function getSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not set");
  return secret;
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

function sign(payload: string): string {
  const header = base64url(JSON.stringify({ alg: ALG, typ: "JWT" }));
  const body = base64url(payload);
  const signature = createHmac("sha256", getSecret())
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function verify(token: string): DecodedMobileToken | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const expected = createHmac("sha256", getSecret())
    .update(`${header}.${body}`)
    .digest("base64url");

  // Constant-time comparison
  if (signature.length !== expected.length) return null;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (!a.equals(b)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString()
    ) as DecodedMobileToken;

    // Check expiry
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

/** Create an access token (24h) for mobile clients */
export function createMobileAccessToken(payload: MobileTokenPayload): string {
  const now = Math.floor(Date.now() / 1000);
  const full = {
    ...payload,
    type: "access" as const,
    iat: now,
    exp: now + ACCESS_TOKEN_MAX_AGE,
    jti: randomBytes(16).toString("hex"),
  };
  return sign(JSON.stringify(full));
}

/** Create a refresh token (30 days) for mobile clients */
export function createMobileRefreshToken(payload: MobileTokenPayload): string {
  const now = Math.floor(Date.now() / 1000);
  const full = {
    ...payload,
    type: "refresh" as const,
    iat: now,
    exp: now + REFRESH_TOKEN_MAX_AGE,
    jti: randomBytes(16).toString("hex"),
  };
  return sign(JSON.stringify(full));
}

/** Verify and decode a mobile JWT. Returns null if invalid or expired. */
export function verifyMobileToken(token: string): DecodedMobileToken | null {
  return verify(token);
}

export type { MobileTokenPayload, DecodedMobileToken };
