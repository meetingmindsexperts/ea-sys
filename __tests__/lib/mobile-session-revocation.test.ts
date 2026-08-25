/**
 * Mobile sessions honour revocation (Aug 25, 2026).
 *
 * THE GAP THIS CLOSES. Web sessions have been revocable since Aug 11 via
 * `decideSessionValidity`: deleted, deactivated, or an explicit `tokenVersion`
 * bump all end the session, immediately for staff and within five minutes for
 * everyone else. The mobile doors were never taught any of it.
 *
 *   - `mobile-login` had NO deactivation check at all, so a deactivated
 *     account could sign in and collect a fresh 24h access token plus a
 *     30-day refresh token.
 *   - `mobile-refresh` re-read the user but only asked whether they still
 *     EXISTED, so a stolen refresh token kept minting access tokens for its
 *     full 30-day life. Deactivating did nothing. Only deleting closed it.
 *
 * So "deactivate the account" was a complete answer on web and a false one on
 * mobile, which is the worst kind of security control: one that an operator
 * reasonably believes they have used.
 *
 * The access path (`api-auth.ts`) is deliberately still signature-only. See
 * the `ponytail:` comment there for the ceiling and its upgrade path.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideSessionValidity } from "@/lib/session-validity";

const SECRET = "test-secret-for-mobile-session-revocation";

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
});

const root = process.cwd();
const readSource = (rel: string) => readFileSync(join(root, rel), "utf8");
/** Strip comments so a source assertion cannot pass on its own explanation. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const basePayload = {
  userId: "u1",
  email: "a@b.com",
  role: "ADMIN",
  organizationId: "org1",
  organizationName: "Org",
  firstName: "A",
  lastName: "B",
};

/** Mint a token the way the code did BEFORE this change: no version claim. */
function legacyToken(type: "access" | "refresh"): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ ...basePayload, type, iat: now, exp: now + 3600, jti: "x" });
  const sig = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

describe("mobile tokens carry the revocation counter", () => {
  it("round-trips tokenVersion through an access token", async () => {
    const { createMobileAccessToken, verifyMobileToken } = await import("@/lib/mobile-jwt");
    const decoded = verifyMobileToken(
      createMobileAccessToken({ ...basePayload, tokenVersion: 7 }),
    );
    expect(decoded?.tokenVersion).toBe(7);
  });

  it("round-trips tokenVersion through a refresh token", async () => {
    const { createMobileRefreshToken, verifyMobileToken } = await import("@/lib/mobile-jwt");
    const decoded = verifyMobileToken(
      createMobileRefreshToken({ ...basePayload, tokenVersion: 3 }),
    );
    expect(decoded?.tokenVersion).toBe(3);
    expect(decoded?.type).toBe("refresh");
  });
});

describe("deploying this does not sign the existing population out", () => {
  it("a pre-change token decodes with no version claim", async () => {
    const { verifyMobileToken } = await import("@/lib/mobile-jwt");
    const decoded = verifyMobileToken(legacyToken("refresh"));
    expect(decoded).not.toBeNull();
    expect(decoded?.tokenVersion).toBeUndefined();
  });

  it("and an absent claim is treated as 0, matching the column default", () => {
    // Every one of the 129 production users sits at tokenVersion 0, checked
    // before shipping. So this is the case that decides whether the deploy is
    // a no-op or a mass sign-out.
    expect(
      decideSessionValidity({ role: "ADMIN", tokenVersion: 0 }, undefined),
    ).toEqual({ action: "refresh", role: "ADMIN" });
  });

  it("but a user whose counter was already bumped IS ended", () => {
    // Deliberate. That account's sessions should have died when it was
    // revoked; on mobile they did not. Ending them is the correction.
    expect(
      decideSessionValidity({ role: "ADMIN", tokenVersion: 1 }, undefined),
    ).toEqual({ action: "invalidate", reason: "token-revoked" });
  });
});

describe("wiring", () => {
  // Rule 9: the decision function was already correct and already tested. The
  // bug was that the mobile doors never called it. These pin the call.

  it("mobile-login refuses a deactivated account", () => {
    const src = codeOnly(readSource("src/app/api/auth/mobile-login/route.ts"));
    expect(src).toContain("deactivatedAt: true");
    expect(src).toMatch(/if \(user\.deactivatedAt\)/);
    expect(src).toContain("BLOCKED_DEACTIVATED");
  });

  it("mobile-refresh asks decideSessionValidity, not just whether the row exists", () => {
    const src = codeOnly(readSource("src/app/api/auth/mobile-refresh/route.ts"));
    expect(src).toContain("decideSessionValidity(user, decoded.tokenVersion)");
    expect(src).toContain("tokenVersion: true");
    expect(src).toContain("deactivatedAt: true");
  });

  it("both mint sites stamp the counter, from the database row", () => {
    // From the ROW, never from the presented token: a bump that lands
    // mid-session has to propagate into the reissued pair, or a refresh would
    // launder a revoked session into a fresh one.
    for (const f of [
      "src/app/api/auth/mobile-login/route.ts",
      "src/app/api/auth/mobile-refresh/route.ts",
    ]) {
      expect(codeOnly(readSource(f))).toContain("tokenVersion: user.tokenVersion");
    }
  });

  it("the access path documents its ceiling rather than leaving it implicit", () => {
    // Signature-only by choice. If someone adds a DB read there later, fine —
    // but the accepted 24h window must not become an undocumented one.
    expect(readSource("src/lib/api-auth.ts")).toContain("ponytail:");
  });
});
