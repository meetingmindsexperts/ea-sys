/**
 * A presenter rate must not be bookable as a delegate (owner decision
 * Aug 12, 2026).
 *
 * WHY THIS EXISTS. Every pricing tier has its own public form URL
 * (`/e/<slug>/register/<tier-slug>`) and the organizer UI had a copy-link
 * button for it, so `/register/presenter-early-bird` opened a fully working
 * DELEGATE registration form at the presenter price. Presenter rates are
 * usually set BELOW the delegate ones, so a forwarded link behaved like a
 * discount code with no code on it: the person got no abstract, no speaker
 * record, and consumed the presenter tier's seat allocation.
 *
 * The gate that matters is the one in the register ROUTE, because that
 * endpoint takes a pricingTierId directly and a page-only refusal would be
 * theatre. These cases pin the predicate against the exact inputs both the
 * route (a tier NAME) and the page (a URL SLUG) feed it.
 */
import { describe, it, expect } from "vitest";
import { isPresenterTierName } from "@/lib/presenter-tiers";

describe("the public gate recognises a presenter rate from a tier NAME", () => {
  it.each(["Presenter", "Presenter Early Bird", "Presenter Standard", "presenter onsite"])(
    "refuses %s",
    (name) => expect(isPresenterTierName(name)).toBe(true),
  );

  it.each(["Early Bird", "Standard", "Onsite", "Late Registration"])(
    "still allows the delegate tier %s",
    (name) => expect(isPresenterTierName(name)).toBe(false),
  );

  /**
   * The one that would silently open the hole again: a tier whose name merely
   * STARTS with the letters is a delegate rate and must stay bookable.
   */
  it("does not refuse a delegate tier that merely starts with the letters", () => {
    expect(isPresenterTierName("Presenters Guild Member")).toBe(false);
  });
});

describe("and from the URL SLUG the public page reads", () => {
  it.each(["presenter", "presenter-early-bird", "presenter-standard"])(
    "signposts %s to the abstract signup",
    (slug) => expect(isPresenterTierName(slug)).toBe(true),
  );

  it.each(["early-bird", "standard", "onsite"])(
    "renders the normal form for %s",
    (slug) => expect(isPresenterTierName(slug)).toBe(false),
  );
});
