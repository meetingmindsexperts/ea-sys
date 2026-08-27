/**
 * The DTCM spare-code pool (Aug 25, 2026).
 *
 * The load-bearing property is that AVAILABILITY IS DERIVED: a pool code is
 * spare iff no registration on the event holds it. There is deliberately no
 * `assignedRegistrationId` column, because three independent writers already
 * touch `Registration.dtcmBarcode` (the CSV importer, the detail sheet's
 * free-text field, this module) and a stored flag would have to be reconciled
 * by every one of them. The failure that buys is not cosmetic: a pool that
 * believes a code is spare while an attendee is wearing it hands the same
 * compliance credential to two people.
 *
 * Everything else here is about the claim never being able to take a
 * registration down with it. A walk-up whose registration succeeded must not be
 * rolled back because a compliance block ran out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    dtcmCode: { findMany: vi.fn(), createMany: vi.fn() },
    registration: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import { Prisma } from "@prisma/client";
import { getDtcmPoolCounts, importDtcmCodes, claimSpareDtcmCode } from "@/lib/dtcm-pool";

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });

/** The registration the claim reads first: Dubai event, in-person, no code. */
const claimable = {
  dtcmBarcode: null,
  attendanceMode: "IN_PERSON",
  event: { requiresDtcmBarcode: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
});

describe("getDtcmPoolCounts — spare is derived, not stored", () => {
  it("counts a code as assigned iff a registration holds it", async () => {
    mockDb.dtcmCode.findMany.mockResolvedValue([{ code: "A" }, { code: "B" }, { code: "C" }]);
    mockDb.registration.findMany.mockResolvedValue([{ dtcmBarcode: "B" }]);

    expect(await getDtcmPoolCounts("ev")).toEqual({
      total: 3,
      assigned: 1,
      spare: 2,
      assignedOutsidePool: 0,
    });
  });

  it("reports codes held but never imported, so the numbers add up on screen", async () => {
    // The ordinary pre-event path: the CSV assigns codes straight to people
    // without them ever passing through the pool. Not an error, but if it were
    // silent the card would look like codes had gone missing.
    mockDb.dtcmCode.findMany.mockResolvedValue([{ code: "A" }]);
    mockDb.registration.findMany.mockResolvedValue([{ dtcmBarcode: "A" }, { dtcmBarcode: "Z" }]);

    const counts = await getDtcmPoolCounts("ev");
    expect(counts).toMatchObject({ total: 1, assigned: 1, spare: 0, assignedOutsidePool: 1 });
  });

  it("an empty pool is zeroes, not a throw", async () => {
    mockDb.dtcmCode.findMany.mockResolvedValue([]);
    mockDb.registration.findMany.mockResolvedValue([]);
    expect(await getDtcmPoolCounts("ev")).toEqual({
      total: 0, assigned: 0, spare: 0, assignedOutsidePool: 0,
    });
  });
});

describe("importDtcmCodes", () => {
  it("dedups within the file and trims, then relies on skipDuplicates for the DB", async () => {
    mockDb.dtcmCode.createMany.mockResolvedValue({ count: 2 });
    const res = await importDtcmCodes({
      eventId: "ev",
      organizationId: "org",
      codes: [" A ", "A", "B", "", "   "],
      importedById: "u1",
    });

    const arg = mockDb.dtcmCode.createMany.mock.calls[0][0];
    expect(arg.data.map((d: { code: string }) => d.code)).toEqual(["A", "B"]);
    expect(arg.skipDuplicates).toBe(true);
    expect(res).toEqual({ imported: 2, duplicates: 0 });
  });

  it("re-importing the same block is a no-op, reported as duplicates", async () => {
    // The behaviour an organiser will try when unsure whether the import landed.
    mockDb.dtcmCode.createMany.mockResolvedValue({ count: 0 });
    expect(
      await importDtcmCodes({ eventId: "ev", organizationId: "org", codes: ["A", "B"], importedById: null }),
    ).toEqual({ imported: 0, duplicates: 2 });
  });

  it("writes nothing at all for an empty list", async () => {
    expect(
      await importDtcmCodes({ eventId: "ev", organizationId: null, codes: ["", "  "], importedById: null }),
    ).toEqual({ imported: 0, duplicates: 0 });
    expect(mockDb.dtcmCode.createMany).not.toHaveBeenCalled();
  });

  it("stamps the tenant key from the caller", async () => {
    mockDb.dtcmCode.createMany.mockResolvedValue({ count: 1 });
    await importDtcmCodes({ eventId: "ev", organizationId: "org-a", codes: ["A"], importedById: "u1" });
    expect(mockDb.dtcmCode.createMany.mock.calls[0][0].data[0]).toMatchObject({
      eventId: "ev",
      organizationId: "org-a",
    });
  });
});

describe("claimSpareDtcmCode — applicability", () => {
  it("requiresDtcm=false short-circuits with ZERO queries", async () => {
    // The fast path. Every non-Dubai registration create calls this, and it must
    // not cost a round trip on the public register hot path.
    const res = await claimSpareDtcmCode({ eventId: "ev", registrationId: "r1", requiresDtcm: false });
    expect(res).toEqual({ status: "not-applicable" });
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
    expect(mockDb.dtcmCode.findMany).not.toHaveBeenCalled();
  });

  it("re-verifies against the row, so a wrong `true` cannot assign", async () => {
    // The caller's flag is a fast path, never the guard.
    mockDb.registration.findFirst.mockResolvedValue({
      ...claimable,
      event: { requiresDtcmBarcode: false },
    });
    expect(await claimSpareDtcmCode({ eventId: "ev", registrationId: "r1", requiresDtcm: true })).toEqual({
      status: "not-applicable",
    });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("skips a VIRTUAL attendee, who has no badge to print a QR on", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ ...claimable, attendanceMode: "VIRTUAL" });
    expect(await claimSpareDtcmCode({ eventId: "ev", registrationId: "r1", requiresDtcm: true })).toEqual({
      status: "not-applicable",
    });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("NEVER overwrites a code the row already holds", async () => {
    // It was put there by the CSV import or by an organiser, and may already be
    // printed on a badge. Replacing it revokes a live credential.
    mockDb.registration.findFirst.mockResolvedValue({ ...claimable, dtcmBarcode: "EXISTING" });
    expect(await claimSpareDtcmCode({ eventId: "ev", registrationId: "r1", requiresDtcm: true })).toEqual({
      status: "already-has-code",
      code: "EXISTING",
    });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });
});

describe("claimSpareDtcmCode — assigning", () => {
  beforeEach(() => {
    mockDb.registration.findFirst.mockResolvedValue(claimable);
  });

  it("hands out the oldest spare and guards the write on the row being empty", async () => {
    mockDb.dtcmCode.findMany.mockResolvedValue([{ code: "A" }, { code: "B" }]);
    mockDb.registration.findMany.mockResolvedValue([{ dtcmBarcode: "A" }]);

    expect(await claimSpareDtcmCode({ eventId: "ev", registrationId: "r1", requiresDtcm: true })).toEqual({
      status: "assigned",
      code: "B",
    });

    const write = mockDb.registration.updateMany.mock.calls[0][0];
    // `dtcmBarcode: null` in the where: a code that landed between the read and
    // the write (a concurrent CSV import) wins instead of being clobbered.
    expect(write.where).toEqual({ id: "r1", eventId: "ev", dtcmBarcode: null });
    expect(write.data).toEqual({ dtcmBarcode: "B" });
  });

  it("gives the spare up when another registration claimed it first", async () => {
    // The unique constraint on dtcmBarcode was DROPPED on 2026-08-27 so a human
    // can deliberately share a code, which took away this loop's P2002
    // contention signal. The POOL must still hand each spare to exactly one
    // person, or "N spare" on the desk strip means nothing.
    mockDb.dtcmCode.findMany.mockResolvedValue([{ code: "A" }, { code: "B" }]);
    mockDb.registration.findMany
      .mockResolvedValueOnce([])                                  // held codes: none
      .mockResolvedValueOnce([{ id: "r0" }, { id: "r1" }])        // holders of A: we lost
      .mockResolvedValueOnce([{ id: "r1" }]);                     // holders of B: ours

    expect(await claimSpareDtcmCode({ eventId: "ev", registrationId: "r1", requiresDtcm: true })).toEqual({
      status: "assigned",
      code: "B",
    });

    // Released A rather than leaving two rows holding it, then took the next.
    const writes = mockDb.registration.updateMany.mock.calls.map((c) => c[0].data);
    expect(writes).toEqual([{ dtcmBarcode: "A" }, { dtcmBarcode: null }, { dtcmBarcode: "B" }]);
    expect(mockLogger.warn.mock.calls.flat().some((a) => JSON.stringify(a).includes("claim-lost-race"))).toBe(true);
  });

  it("keeps the spare when it is the lowest id among holders (deterministic tie-break)", async () => {
    // Both racers backing off would leave the walk-up with no code at all, which
    // is the outcome this module exists to prevent. One of them must win.
    mockDb.dtcmCode.findMany.mockResolvedValue([{ code: "A" }]);
    mockDb.registration.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "r1" }, { id: "r2" }]);       // we are lowest

    expect(await claimSpareDtcmCode({ eventId: "ev", registrationId: "r1", requiresDtcm: true })).toEqual({
      status: "assigned",
      code: "A",
    });
    expect(mockDb.registration.updateMany.mock.calls.map((c) => c[0].data)).toEqual([{ dtcmBarcode: "A" }]);
  });

  it("never logs the full code — it is a compliance credential", async () => {
    mockDb.dtcmCode.findMany.mockResolvedValue([{ code: "DTCM-SECRET-VALUE-1234" }]);
    mockDb.registration.findMany.mockResolvedValue([]);
    await claimSpareDtcmCode({ eventId: "ev", registrationId: "r1", requiresDtcm: true });

    const logged = JSON.stringify(mockLogger.info.mock.calls);
    expect(logged).not.toContain("DTCM-SECRET-VALUE-1234");
    expect(logged).toContain("DTCM-SEC");
  });

  it("moves to the next spare when another station took this one (P2002)", async () => {
    // The contention path. No lock and no transaction held across a desk
    // interaction: the unique constraint that already exists is the referee.
    mockDb.dtcmCode.findMany.mockResolvedValue([{ code: "A" }, { code: "B" }]);
    mockDb.registration.findMany.mockResolvedValue([]);
    mockDb.registration.updateMany
      .mockRejectedValueOnce(p2002())
      .mockResolvedValueOnce({ count: 1 });

    expect(await claimSpareDtcmCode({ eventId: "ev", registrationId: "r1", requiresDtcm: true })).toEqual({
      status: "assigned",
      code: "B",
    });
    expect(mockDb.registration.updateMany).toHaveBeenCalledTimes(2);
  });

  it("reports an empty pool rather than failing, and says so in the log", async () => {
    mockDb.dtcmCode.findMany.mockResolvedValue([{ code: "A" }]);
    mockDb.registration.findMany.mockResolvedValue([{ dtcmBarcode: "A" }]);

    expect(await claimSpareDtcmCode({ eventId: "ev", registrationId: "r1", requiresDtcm: true })).toEqual({
      status: "pool-empty",
    });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("a code that landed concurrently is honoured, not clobbered", async () => {
    mockDb.dtcmCode.findMany.mockResolvedValue([{ code: "A" }]);
    mockDb.registration.findMany.mockResolvedValue([]);
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    mockDb.registration.findFirst
      .mockResolvedValueOnce(claimable)
      .mockResolvedValueOnce({ dtcmBarcode: "ARRIVED-FIRST" });

    expect(await claimSpareDtcmCode({ eventId: "ev", registrationId: "r1", requiresDtcm: true })).toEqual({
      status: "already-has-code",
      code: "ARRIVED-FIRST",
    });
  });

  it("NEVER throws, whatever the database does", async () => {
    // The whole contract: a registration that committed must not be undone
    // because a compliance code could not be found.
    mockDb.registration.findFirst.mockRejectedValue(new Error("pool timeout"));
    await expect(
      claimSpareDtcmCode({ eventId: "ev", registrationId: "r1", requiresDtcm: true }),
    ).resolves.toEqual({ status: "failed" });
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
