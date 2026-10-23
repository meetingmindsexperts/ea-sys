/** RSVP import filters (Oct 23, 2026): type, status, payment, badge role. */
import { describe, it, expect } from "vitest";
import {
  ANY,
  DEFAULT_FILTERS,
  SPEAKER_DEFAULT_FILTERS,
  distinct,
  matchesFilters,
  titleCase,
} from "@/lib/rsvp-import-filters";

const physician = { status: "CONFIRMED", typeId: "phys", paymentStatus: "PAID", badgeType: "Delegate" };
const cancelled = { ...physician, status: "CANCELLED" };
const exhibitor = { status: "CONFIRMED", typeId: "exh", paymentStatus: "COMPLIMENTARY", badgeType: "Exhibitor" };

describe("matchesFilters", () => {
  it("by default leaves out cancelled registrations, keeps everyone else", () => {
    expect(matchesFilters(physician, DEFAULT_FILTERS)).toBe(true);
    expect(matchesFilters(cancelled, DEFAULT_FILTERS)).toBe(false);
  });

  it("'Any status' brings cancelled back; a named status matches only it", () => {
    expect(matchesFilters(cancelled, { ...DEFAULT_FILTERS, status: ANY })).toBe(true);
    expect(matchesFilters(physician, { ...DEFAULT_FILTERS, status: "PENDING" })).toBe(false);
  });

  it("filters by type, payment and badge role, all together", () => {
    const f = { ...DEFAULT_FILTERS, type: "exh", payment: "COMPLIMENTARY", badge: "Exhibitor" };
    expect(matchesFilters(exhibitor, f)).toBe(true);
    expect(matchesFilters(physician, f)).toBe(false);
    expect(matchesFilters(exhibitor, { ...f, payment: "PAID" })).toBe(false);
  });

  it("speakers start with every status, including cancelled", () => {
    expect(matchesFilters({ status: "CANCELLED" }, SPEAKER_DEFAULT_FILTERS)).toBe(true);
  });

  it("a badge filter does not match someone with no badge role", () => {
    expect(matchesFilters({ status: "CONFIRMED" }, { ...DEFAULT_FILTERS, badge: "Faculty" })).toBe(false);
  });
});

describe("helpers", () => {
  it("distinct drops blanks and sorts", () => {
    expect(distinct(["PAID", undefined, "COMPLIMENTARY", "PAID", ""])).toEqual(["COMPLIMENTARY", "PAID"]);
  });
  it("titleCase", () => {
    expect(titleCase("COMPLIMENTARY")).toBe("Complimentary");
    expect(titleCase("CHECKED_IN")).toBe("Checked in");
  });
});
