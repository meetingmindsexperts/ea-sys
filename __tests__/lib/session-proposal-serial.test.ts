/**
 * Session-proposal serial counter + display format (Aug 4, 2026 — same-day
 * sibling of the abstract A-### serial: proposals get S-###).
 */
import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  getNextSessionProposalSerialId,
  formatSessionProposalSerial,
} from "@/lib/session-proposal-serial";

describe("getNextSessionProposalSerialId", () => {
  it("upserts atomically: create starts at 1, update increments, org stamped on both branches", async () => {
    const upsert = vi.fn().mockResolvedValue({ lastSerial: 3 });
    const tx = { sessionProposalSerialCounter: { upsert } } as unknown as Prisma.TransactionClient;

    const serial = await getNextSessionProposalSerialId(tx, "ev1", "org1");

    expect(serial).toBe(3);
    expect(upsert).toHaveBeenCalledWith({
      where: { eventId: "ev1" },
      create: { eventId: "ev1", lastSerial: 1, organizationId: "org1" },
      update: { lastSerial: { increment: 1 }, organizationId: "org1" },
    });
  });
});

describe("formatSessionProposalSerial", () => {
  it("renders S-prefixed zero-padded serials, distinct from A-/registration formats", () => {
    expect(formatSessionProposalSerial(1)).toBe("S-001");
    expect(formatSessionProposalSerial(42)).toBe("S-042");
    expect(formatSessionProposalSerial(1234)).toBe("S-1234");
  });

  it("renders an em-dash for missing serials (pre-migration legacy rows)", () => {
    expect(formatSessionProposalSerial(null)).toBe("—");
    expect(formatSessionProposalSerial(undefined)).toBe("—");
  });
});
