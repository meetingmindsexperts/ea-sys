/**
 * What a registration imported with no type owes (owner, Nov 9, 2026): a free
 * event COMPLIMENTARY, a paid event UNASSIGNED. "Paid" counts the type's own
 * price, its rates and its virtual price, and never the Faculty type.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { count } = vi.hoisted(() => ({ count: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { ticketType: { count } } }));

import { eventChargesForRegistration, untypedImportPaymentStatus } from "@/lib/import-ticket-type";

describe("eventChargesForRegistration", () => {
  beforeEach(() => count.mockReset());

  it("counts a priced type, a priced rate or a priced virtual rate, never the Faculty type", async () => {
    count.mockResolvedValue(1);
    await expect(eventChargesForRegistration("ev1")).resolves.toBe(true);
    expect(count).toHaveBeenCalledWith({
      where: {
        eventId: "ev1",
        isFaculty: false,
        OR: [{ price: { gt: 0 } }, { virtualPrice: { gt: 0 } }, { pricingTiers: { some: { price: { gt: 0 } } } }],
      },
    });
  });

  it("an event with nothing priced is free", async () => {
    count.mockResolvedValue(0);
    await expect(eventChargesForRegistration("ev1")).resolves.toBe(false);
  });
});

describe("untypedImportPaymentStatus", () => {
  it("is UNASSIGNED on a paid event and COMPLIMENTARY on a free one", () => {
    expect(untypedImportPaymentStatus(true)).toBe("UNASSIGNED");
    expect(untypedImportPaymentStatus(false)).toBe("COMPLIMENTARY");
  });
});
