/**
 * Presenter tier family (Aug 11, 2026). See docs/PRESENTER_REGISTRATION_PLAN.md.
 *
 * "Presenter" used to be one tier that exactly one line of code recognised, by
 * exact string match, so the public register redirect would skip it. It becomes
 * a FAMILY (`Presenter Early Bird` / `Presenter Standard`) and three places now
 * need to recognise it, so the match moved into one predicate.
 *
 * The property that matters: a delegate must never be auto-landed on a
 * presenter rate. An exact match silently stops excluding the moment the tier
 * is renamed, and the failure is a wrong price on a live registration page.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_TIER_NAMES,
  DELEGATE_TIER_PRIORITY,
  isPresenterTierName,
  tierSlug,
} from "@/lib/presenter-tiers";

describe("isPresenterTierName", () => {
  it("matches the whole presenter family", () => {
    for (const n of [
      "Presenter",
      "Presenter Early Bird",
      "Presenter Standard",
      "presenter early bird",
      "  Presenter   Onsite  ",
    ]) {
      expect(isPresenterTierName(n)).toBe(true);
    }
  });

  /** The 69 dead tiers on prod are named exactly "Presenter" and stay recognised. */
  it("still matches the legacy single Presenter tier", () => {
    expect(isPresenterTierName("Presenter")).toBe(true);
  });

  it("does not match delegate tiers", () => {
    for (const n of ["Early Bird", "Standard", "Onsite", "Group", "VIP"]) {
      expect(isPresenterTierName(n)).toBe(false);
    }
  });

  /**
   * A bare prefix test would swallow this and quietly hide a delegate tier
   * from the public register page, which is why the prefix must be followed by
   * a separator or end the string.
   */
  it("does not match a name that merely starts with the letters", () => {
    expect(isPresenterTierName("Presenters Guild Member")).toBe(false);
    expect(isPresenterTierName("Presentation Only")).toBe(false);
  });

  it("is safe on absent input", () => {
    expect(isPresenterTierName(null)).toBe(false);
    expect(isPresenterTierName(undefined)).toBe(false);
    expect(isPresenterTierName("")).toBe(false);
  });
});

describe("tierSlug", () => {
  it("matches the slug form the public register URLs use", () => {
    expect(tierSlug("Early Bird")).toBe("early-bird");
    expect(tierSlug("  Presenter Early Bird ")).toBe("presenter-early-bird");
  });
});

describe("DEFAULT_TIER_NAMES", () => {
  /**
   * Seeded onto every new registration type. The single "Presenter" is gone:
   * it had zero registrations across 69 rows on prod because the abstract door
   * bypassed it, and it cannot carry a ladder.
   */
  it("seeds the delegate ladder plus a presenter ladder", () => {
    expect(DEFAULT_TIER_NAMES).toEqual([
      "Early Bird",
      "Standard",
      "Onsite",
      "Presenter Early Bird",
      "Presenter Standard",
    ]);
  });

  it("no longer seeds a bare Presenter tier", () => {
    expect(DEFAULT_TIER_NAMES).not.toContain("Presenter");
  });

  /** Every seeded name must fall on exactly one side of the predicate. */
  it("partitions cleanly into delegate and presenter tiers", () => {
    const presenter = DEFAULT_TIER_NAMES.filter(isPresenterTierName);
    const delegate = DEFAULT_TIER_NAMES.filter((n) => !isPresenterTierName(n));
    expect(presenter).toEqual(["Presenter Early Bird", "Presenter Standard"]);
    expect(delegate.map(tierSlug)).toEqual(DELEGATE_TIER_PRIORITY);
  });
});

/**
 * D5, reversed after the owner asked what was consistent with the platform.
 * An abstract submitter comes through an unauthenticated public door on a
 * priced tier and is charged, which is the same shape as PUBLIC_REGISTER, so
 * they draw down that tier. NOT the SPEAKER_COMPANION exclusion, which exists
 * because comp faculty do not consume a venue seat.
 */
describe("PUBLIC_SUBMITTER seat accounting (D5)", () => {
  it("counts on the presenter tier it was sold at", async () => {
    const { seatCounter } = await import("@/lib/registration-seat");
    expect(
      seatCounter({
        createdSource: "PUBLIC_SUBMITTER",
        pricingTierId: "presenter-early-bird",
        ticketTypeId: "physician",
      }),
    ).toEqual({ kind: "tier", id: "presenter-early-bird" });
  });

  it("falls back to the ticket type when no presenter tier was configured (D4)", async () => {
    const { seatCounter } = await import("@/lib/registration-seat");
    expect(
      seatCounter({ createdSource: "PUBLIC_SUBMITTER", pricingTierId: null, ticketTypeId: "physician" }),
    ).toEqual({ kind: "ticketType", id: "physician" });
  });

  it("is NOT treated like a comp faculty companion", async () => {
    const { seatCounter } = await import("@/lib/registration-seat");
    // The companion sits on no counter at all; a paying presenter must not.
    expect(
      seatCounter({ createdSource: "SPEAKER_COMPANION", pricingTierId: "t", ticketTypeId: "faculty" }),
    ).toBeNull();
    expect(
      seatCounter({ createdSource: "PUBLIC_SUBMITTER", pricingTierId: "t", ticketTypeId: "physician" }),
    ).not.toBeNull();
  });
});
