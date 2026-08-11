/**
 * decideSessionValidity — the session revocation truth table (Aug 11, 2026).
 *
 * Sessions are stateless JWTs, so nothing server-side can be deleted to sign
 * someone out. The only lever is the periodic re-validation that already runs
 * every 5 minutes, and it used to act on exactly ONE of the three answers the
 * database can give:
 *
 *   "they are a MEMBER now"   -> handled, role rewritten
 *   "they do not exist"       -> IGNORED, request continued as the cached role
 *   "their access is revoked" -> could not even be asked
 *
 * The middle one is the live bug these pin: a deleted ADMIN stayed an ADMIN,
 * and because the 24h window is a ROLLING idle timeout, an actively-used
 * session never expired at all.
 */
import { describe, it, expect } from "vitest";
import { decideSessionValidity } from "@/lib/session-validity";

describe("decideSessionValidity", () => {
  it("refreshes the role when the user exists and versions match", () => {
    expect(decideSessionValidity({ role: "MEMBER", tokenVersion: 0 }, 0)).toEqual({
      action: "refresh",
      role: "MEMBER",
    });
  });

  it("carries a role CHANGE through rather than signing the person out", () => {
    // Demoting a colleague should downgrade them, not eject them. Only an
    // explicit revocation (a version bump) ends the session.
    expect(decideSessionValidity({ role: "MEMBER", tokenVersion: 3 }, 3)).toEqual({
      action: "refresh",
      role: "MEMBER",
    });
  });

  it("invalidates when the user row is gone (the delete-does-not-revoke bug)", () => {
    expect(decideSessionValidity(null, 0)).toEqual({
      action: "invalidate",
      reason: "user-deleted",
    });
  });

  it("invalidates a deleted user regardless of what version their token claims", () => {
    expect(decideSessionValidity(null, 99).action).toBe("invalidate");
    expect(decideSessionValidity(null, undefined).action).toBe("invalidate");
  });

  it("invalidates when the counter was bumped after the token was minted", () => {
    expect(decideSessionValidity({ role: "ADMIN", tokenVersion: 2 }, 1)).toEqual({
      action: "invalidate",
      reason: "token-revoked",
    });
  });

  /**
   * The rollout property. Tokens minted before the claim existed carry no
   * `tokenVersion` at all. If `undefined` did not read as 0 this change would
   * sign out every logged-in person the moment it deployed — during a live
   * event, which is the sort of thing that gets noticed.
   */
  it("treats a token with NO version claim as version 0, so the deploy signs nobody out", () => {
    expect(decideSessionValidity({ role: "ORGANIZER", tokenVersion: 0 }, undefined)).toEqual({
      action: "refresh",
      role: "ORGANIZER",
    });
  });

  it("still revokes a claim-less token once the counter has moved", () => {
    // Someone signed in before this shipped, then had their password reset.
    expect(decideSessionValidity({ role: "ORGANIZER", tokenVersion: 1 }, undefined)).toEqual({
      action: "invalidate",
      reason: "token-revoked",
    });
  });

  it("does not treat a HIGHER token version as valid", () => {
    // A forged or replayed token claiming a future version must not pass. The
    // check is equality, deliberately, not >=.
    expect(decideSessionValidity({ role: "ADMIN", tokenVersion: 1 }, 5)).toEqual({
      action: "invalidate",
      reason: "token-revoked",
    });
  });
});
