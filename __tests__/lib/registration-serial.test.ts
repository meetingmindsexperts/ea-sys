/**
 * Pins the fix for the getNextSerialId race found in the May 2026 audit.
 *
 * The old implementation did `aggregate(_max: serialId) + 1`, which takes
 * no row lock under Read Committed even inside a transaction — two
 * concurrent registrations both read the same max, both inserted the same
 * serialId, one hit P2002 on @@unique([eventId, serialId]), and the public
 * register route mis-reported it as "You are already registered".
 *
 * It now uses an atomic upsert+increment on RegistrationSerialCounter
 * (compiles to INSERT ... ON CONFLICT DO UPDATE SET lastSerial = lastSerial
 * + 1, which takes a row lock and serializes concurrent callers).
 */
import { describe, it, expect, vi } from "vitest";
import { getNextSerialId, formatSerialId } from "@/lib/registration-serial";

describe("getNextSerialId", () => {
  it("upserts the per-event counter and returns the new lastSerial", async () => {
    const upsert = vi.fn().mockResolvedValue({ eventId: "ev1", lastSerial: 43 });
    const tx = { registrationSerialCounter: { upsert } } as never;

    const result = await getNextSerialId(tx, "ev1");

    expect(result).toBe(43);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith({
      where: { eventId: "ev1" },
      create: { eventId: "ev1", lastSerial: 1 },
      update: { lastSerial: { increment: 1 } },
    });
  });

  it("returns 1 for an event's first registration (counter create path)", async () => {
    const upsert = vi.fn().mockResolvedValue({ eventId: "new", lastSerial: 1 });
    const tx = { registrationSerialCounter: { upsert } } as never;
    expect(await getNextSerialId(tx, "new")).toBe(1);
  });

  it("does NOT use a MAX() aggregate (the racy old path is gone)", async () => {
    const aggregate = vi.fn();
    const upsert = vi.fn().mockResolvedValue({ eventId: "ev", lastSerial: 2 });
    const tx = {
      registration: { aggregate },
      registrationSerialCounter: { upsert },
    } as never;

    await getNextSerialId(tx, "ev");

    expect(aggregate).not.toHaveBeenCalled();
  });
});

describe("formatSerialId", () => {
  it("zero-pads to 3 digits", () => {
    expect(formatSerialId(1)).toBe("001");
    expect(formatSerialId(42)).toBe("042");
    expect(formatSerialId(1234)).toBe("1234");
  });
  it("renders an em dash for null/undefined", () => {
    expect(formatSerialId(null)).toBe("—");
    expect(formatSerialId(undefined)).toBe("—");
  });
});
