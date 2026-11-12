/**
 * The one-off script's plan for each registration on the adopted type (Nov 12,
 * 2026). The dry run prints this plan and the write follows it, so the plan is
 * the thing to pin.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {}, tenantTransaction: vi.fn() }));
vi.mock("../../src/lib/db", () => ({ db: {}, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { planRow } from "../../scripts/adopt-ordinary-faculty-type";

describe("planRow", () => {
  const PENDING = { status: "PENDING", paymentStatus: "UNPAID" };

  it("settles a pending, unpaid registration whose speaker is confirmed or still invited", () => {
    expect(planRow(PENDING, "CONFIRMED")).toBe("settle");
    expect(planRow(PENDING, "INVITED")).toBe("settle");
  });

  // Review of 2727a13f: nobody confirmed a person with no speaker record, so
  // approving them is the organiser's to do, not a script's.
  it("leaves a registration with no speaker record, and says which kind of leave", () => {
    expect(planRow(PENDING, null)).toBe("leave-no-speaker");
    expect(planRow(PENDING, null, { cancelDeclined: true })).toBe("leave-no-speaker");
  });

  // Owner, July 11, 2026: cancelling on a decline is a choice. Someone who
  // declined to speak may still attend.
  it.each(["DECLINED", "CANCELLED"])("keeps the registration of a speaker who is %s unless asked to cancel", (status) => {
    expect(planRow(PENDING, status)).toBe("leave-declined");
    expect(planRow(PENDING, status, { cancelDeclined: true })).toBe("cancel");
    expect(planRow({ status: "CONFIRMED", paymentStatus: "COMPLIMENTARY" }, status, { cancelDeclined: true })).toBe("cancel");
  });

  it("never cancels a checked-in registration, or one that money has touched, even when asked", () => {
    const ask = { cancelDeclined: true };
    expect(planRow({ status: "CHECKED_IN", paymentStatus: "COMPLIMENTARY" }, "DECLINED", ask)).toBe("leave");
    for (const paymentStatus of ["PAID", "PENDING", "FAILED", "REFUNDED", "INCLUSIVE"]) {
      expect(planRow({ status: "CONFIRMED", paymentStatus }, "DECLINED", ask)).toBe("leave");
    }
  });

  // An event that has ended: cancelling afterwards would rewrite who attended.
  it("never cancels on an event that has ended, and still settles there", () => {
    expect(planRow(PENDING, "DECLINED", { eventEnded: true, cancelDeclined: true })).toBe("leave-declined");
    expect(planRow(PENDING, "CONFIRMED", { eventEnded: true })).toBe("settle");
  });

  it("leaves what is already in line, and anything already cancelled", () => {
    expect(planRow({ status: "CONFIRMED", paymentStatus: "COMPLIMENTARY" }, "CONFIRMED")).toBe("leave");
    expect(planRow({ status: "CANCELLED", paymentStatus: "UNPAID" }, "DECLINED", { cancelDeclined: true })).toBe("leave");
    expect(planRow({ status: "CHECKED_IN", paymentStatus: "PAID" }, "CONFIRMED")).toBe("leave");
  });
});
