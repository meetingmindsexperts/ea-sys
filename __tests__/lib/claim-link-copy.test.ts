import { describe, it, expect } from "vitest";
import { claimLinkCopy, readClaimLinkState } from "@/lib/claim-link-copy";

/**
 * The abstract sign-up screen said "We sent you a link" when the route had
 * just said it could not send one (found by the Nov 13, 2026 test run). The
 * screen now follows what the route reports.
 */
describe("the confirm-your-email screen says what really happened to the link", () => {
  it("sent: it says so", () => {
    const copy = claimLinkCopy("sent");
    expect(copy.lead).toContain("We sent you a link");
    expect(copy.step).toBe("Open the confirmation link we emailed you");
  });

  it("sent recently: it points at the latest one", () => {
    const copy = claimLinkCopy("rate-limited");
    expect(copy.lead).toContain("We sent you a link recently");
    expect(copy.step).toContain("latest");
  });

  it("could not be sent: it never claims an email is on its way", () => {
    const copy = claimLinkCopy("failed");
    expect(copy.lead).toContain("We could not send the confirmation link");
    expect(`${copy.lead} ${copy.step}`).not.toMatch(/we sent|we emailed/i);
  });

  it("every case still says why: the organisers hold a profile for this email", () => {
    for (const state of ["sent", "rate-limited", "failed"] as const) {
      expect(claimLinkCopy(state).lead).toContain("already have a speaker profile");
    }
  });

  it("a route that does not say (the other slot during a deploy) is read as sent, as before", () => {
    for (const value of [undefined, null, "", "sent", "nonsense", 1]) expect(readClaimLinkState(value)).toBe("sent");
    expect(readClaimLinkState("failed")).toBe("failed");
    expect(readClaimLinkState("rate-limited")).toBe("rate-limited");
  });
});
