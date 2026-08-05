/**
 * Sign-out landing (Aug 5, 2026, owner report): attendee-side roles must land
 * on their EVENT sign-in, not the internal /login. Pins the role matrix, the
 * re-login redirect params, and the no-event fallback.
 */
import { describe, it, expect } from "vitest";
import { signOutCallbackUrl } from "@/lib/sign-out-target";

const ev = { id: "ev1", slug: "MEHF2026" };

describe("signOutCallbackUrl", () => {
  it("staff roles keep the internal /login", () => {
    for (const role of ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "ONSITE", "WEBINARS", "CRM_USER"]) {
      expect(signOutCallbackUrl(role, ev)).toBe("/login");
    }
  });

  it("REVIEWER deliberately keeps /login (may span events/orgs)", () => {
    expect(signOutCallbackUrl("REVIEWER", ev)).toBe("/login");
  });

  it("SUBMITTER lands on the event login with a My Details re-login redirect", () => {
    expect(signOutCallbackUrl("SUBMITTER", ev)).toBe(
      `/e/MEHF2026/login?redirect=${encodeURIComponent("/events/ev1/my-details")}`,
    );
  });

  it("REGISTRANT lands on the event login with the registration redirect", () => {
    expect(signOutCallbackUrl("REGISTRANT", ev)).toBe("/e/MEHF2026/login?redirect=registration");
  });

  it("falls back to /login when no event (or no slug) is resolvable", () => {
    expect(signOutCallbackUrl("SUBMITTER", null)).toBe("/login");
    expect(signOutCallbackUrl("SUBMITTER", undefined)).toBe("/login");
    expect(signOutCallbackUrl("REGISTRANT", { id: "ev1", slug: null })).toBe("/login");
  });

  it("undefined role (session not yet loaded) falls back to /login", () => {
    expect(signOutCallbackUrl(undefined, ev)).toBe("/login");
    expect(signOutCallbackUrl(null, ev)).toBe("/login");
  });
});
