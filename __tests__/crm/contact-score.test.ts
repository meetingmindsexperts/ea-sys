/**
 * CRM contact score — the deals-only formula (owner decision, July 21 2026).
 *
 * The score is DERIVED, never stored: these tests pin the formula so a later
 * "tweak" is a deliberate, reviewed change, not drift. Formula:
 *   open deals → 30 + 15×extra, capped at 60 · any won deal → +40 · clamp 100.
 */
import { describe, it, expect } from "vitest";
import { computeContactScore, contactScoreColor } from "@/crm/lib/contact-score";

describe("computeContactScore — deals-only formula", () => {
  it("no deals → 0", () => {
    expect(computeContactScore({ openDeals: 0, wonDeals: 0 }).total).toBe(0);
  });

  it("one open deal → 30", () => {
    const s = computeContactScore({ openDeals: 1, wonDeals: 0 });
    expect(s).toEqual({ openDealPoints: 30, wonDealPoints: 0, total: 30 });
  });

  it("two open deals → 45; three → 60 (cap)", () => {
    expect(computeContactScore({ openDeals: 2, wonDeals: 0 }).total).toBe(45);
    expect(computeContactScore({ openDeals: 3, wonDeals: 0 }).total).toBe(60);
  });

  it("open-deal points cap at 60 no matter how many deals", () => {
    expect(computeContactScore({ openDeals: 50, wonDeals: 0 }).openDealPoints).toBe(60);
  });

  it("a won deal adds 40, once — multiple wins don't stack", () => {
    expect(computeContactScore({ openDeals: 0, wonDeals: 1 }).total).toBe(40);
    expect(computeContactScore({ openDeals: 0, wonDeals: 5 }).total).toBe(40);
  });

  it("open + won combine and clamp to 100", () => {
    // 3 open (60) + won (40) = exactly 100
    expect(computeContactScore({ openDeals: 3, wonDeals: 1 }).total).toBe(100);
    // 10 open would be 60 anyway — still 100, never above
    expect(computeContactScore({ openDeals: 10, wonDeals: 2 }).total).toBe(100);
  });

  it("negative/fractional counts are a caller bug, not a negative score", () => {
    expect(computeContactScore({ openDeals: -3, wonDeals: -1 }).total).toBe(0);
    expect(computeContactScore({ openDeals: 1.9, wonDeals: 0 }).total).toBe(30);
  });
});

describe("contactScoreColor — cold/warm/hot bands", () => {
  it("bands at 30 and 60", () => {
    expect(contactScoreColor(0)).toContain("slate");
    expect(contactScoreColor(29)).toContain("slate");
    expect(contactScoreColor(30)).toContain("amber");
    expect(contactScoreColor(59)).toContain("amber");
    expect(contactScoreColor(60)).toContain("emerald");
    expect(contactScoreColor(100)).toContain("emerald");
  });
});

