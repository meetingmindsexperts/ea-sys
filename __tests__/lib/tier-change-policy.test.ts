/** The shared tier-change rule (Oct 22, 2026): unpaid, or nothing owed; never once paid. */
import { describe, it, expect } from "vitest";
import { tierChangeAllowed } from "@/lib/tier-change-policy";

describe("tierChangeAllowed", () => {
  it.each(["UNASSIGNED", "UNPAID", "PENDING", "COMPLIMENTARY", "INCLUSIVE"])("allows %s", (s) => {
    expect(tierChangeAllowed(s)).toBe(true);
  });
  it.each(["PAID", "REFUNDED", "FAILED", ""])("refuses %s", (s) => {
    expect(tierChangeAllowed(s)).toBe(false);
  });
});
