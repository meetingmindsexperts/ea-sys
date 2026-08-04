/**
 * Abstract serial counter + display format (Aug 4, 2026 — organizer request:
 * "an abstract should have an id").
 *
 * Pins:
 *  - the atomic upsert+increment shape (the registration-counter pattern; a
 *    MAX()+1 read would race — see registration-serial.ts history)
 *  - the "A-001" display format incl. the null → "—" legacy fallback and the
 *    visual distinction from Registration # ("001").
 */
import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { getNextAbstractSerialId, formatAbstractSerial } from "@/lib/abstract-serial";

describe("getNextAbstractSerialId", () => {
  it("upserts atomically: create starts at 1, update increments, org stamped on both branches", async () => {
    const upsert = vi.fn().mockResolvedValue({ lastSerial: 8 });
    const tx = { abstractSerialCounter: { upsert } } as unknown as Prisma.TransactionClient;

    const serial = await getNextAbstractSerialId(tx, "ev1", "org1");

    expect(serial).toBe(8);
    expect(upsert).toHaveBeenCalledWith({
      where: { eventId: "ev1" },
      create: { eventId: "ev1", lastSerial: 1, organizationId: "org1" },
      update: { lastSerial: { increment: 1 }, organizationId: "org1" },
    });
  });
});

describe("formatAbstractSerial", () => {
  it("renders A-prefixed zero-padded serials", () => {
    expect(formatAbstractSerial(1)).toBe("A-001");
    expect(formatAbstractSerial(42)).toBe("A-042");
    expect(formatAbstractSerial(999)).toBe("A-999");
  });

  it("grows past three digits without truncating", () => {
    expect(formatAbstractSerial(1234)).toBe("A-1234");
  });

  it("renders an em-dash for missing serials (pre-migration legacy rows)", () => {
    expect(formatAbstractSerial(null)).toBe("—");
    expect(formatAbstractSerial(undefined)).toBe("—");
  });
});
