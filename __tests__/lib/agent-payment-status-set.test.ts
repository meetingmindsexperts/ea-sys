/**
 * Pins the fix for the PaymentStatus enum drift found in the May 2026 audit.
 *
 * `ALL_PAYMENT_STATUSES` was a hand-maintained Set that fell behind the
 * Prisma enum: it was missing `INCLUSIVE` (added with the sponsor-paid
 * feature), so the MCP `update_registration` / `bulk_update_registration_status`
 * guards rejected INCLUSIVE as invalid and the INCLUSIVE-handling code was
 * unreachable — the agent could never mark a registration sponsor-paid.
 *
 * It is now derived from the generated Prisma enum so it cannot drift again.
 */
import { describe, it, expect } from "vitest";
import { PaymentStatus } from "@prisma/client";
import { ALL_PAYMENT_STATUSES } from "@/lib/agent/tools/_shared";
import { ADMIN_SETTABLE_PAYMENT_STATUSES, MANUAL_PAYMENT_STATUSES } from "@/lib/registration-payment-policy";
import { MANUAL_PAYMENT_STATUSES as UI_MANUAL_PAYMENT_STATUSES } from "@/app/(dashboard)/events/[eventId]/registrations/registration-enums";

describe("ALL_PAYMENT_STATUSES", () => {
  it("contains every Prisma PaymentStatus value (no drift possible)", () => {
    for (const v of Object.values(PaymentStatus)) {
      expect(ALL_PAYMENT_STATUSES.has(v)).toBe(true);
    }
    expect(ALL_PAYMENT_STATUSES.size).toBe(Object.values(PaymentStatus).length);
  });

  it("includes the values the old hardcoded set was missing", () => {
    // The exact regression: INCLUSIVE (sponsor-paid) + UNASSIGNED (admin
    // pending) were absent, making them unusable via the agent.
    expect(ALL_PAYMENT_STATUSES.has("INCLUSIVE")).toBe(true);
    expect(ALL_PAYMENT_STATUSES.has("UNASSIGNED")).toBe(true);
  });

  it("rejects an unknown value (still a real whitelist)", () => {
    expect(ALL_PAYMENT_STATUSES.has("WHATEVER")).toBe(false);
  });
});

describe("ADMIN_SETTABLE_PAYMENT_STATUSES (review H12)", () => {
  it("is the one list the UI offers, not a copy of it (dependency audit, Nov 3 2026)", () => {
    // It was written out four times with a test keeping two in step; now the
    // UI re-exports the policy module's list and the set is built from it.
    expect(UI_MANUAL_PAYMENT_STATUSES).toBe(MANUAL_PAYMENT_STATUSES);
    expect([...ADMIN_SETTABLE_PAYMENT_STATUSES]).toEqual([...MANUAL_PAYMENT_STATUSES]);
    expect([...MANUAL_PAYMENT_STATUSES].sort()).toEqual(["COMPLIMENTARY", "INCLUSIVE", "PAID", "UNASSIGNED", "UNPAID"]);
  });

  it("excludes every webhook/refund-flow-owned status", () => {
    for (const owned of ["PENDING", "REFUNDED", "FAILED"]) {
      expect(ADMIN_SETTABLE_PAYMENT_STATUSES.has(owned)).toBe(false);
    }
  });
});
