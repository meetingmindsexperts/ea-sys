/**
 * scripts/merge-faculty-types.ts on a REAL Postgres (review of 9a57f2a5).
 *
 * The script deletes a registration type on production. Its unit test mocks
 * the database and reads the source as text, so a wrong `where` (moving the
 * wrong rows, renaming every attendee, counting seats onto the wrong type)
 * would pass. This runs the write itself and looks at the rows.
 *
 * Run: INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { donorBlocks, mergeDonor, referencesTo } from "../../scripts/merge-faculty-types";
import { resetCrm } from "./helper";

let orgId: string;
let userId: string;
let eventId: string;
let keeperId: string;
let donorId: string;
let counter = 0;

async function facultyType(name: string, over: { soldCount?: number; isActive?: boolean } = {}): Promise<string> {
  const row = await db.ticketType.create({
    data: { eventId, organizationId: orgId, name, price: 0, isFaculty: true, soldCount: over.soldCount ?? 0, isActive: over.isActive ?? true },
    select: { id: true },
  });
  return row.id;
}

async function registration(ticketTypeId: string, email: string, over: { typeText?: string | null; status?: "CONFIRMED" | "CANCELLED" | "PENDING"; pricingTierId?: string } = {}) {
  const attendee = await db.attendee.create({
    data: { organizationId: orgId, email, firstName: "A", lastName: "B", registrationType: over.typeText === undefined ? null : over.typeText },
    select: { id: true },
  });
  counter += 1;
  return db.registration.create({
    data: {
      organizationId: orgId, eventId, attendeeId: attendee.id, ticketTypeId, serialId: counter, qrCode: `QR-${counter}`,
      status: over.status ?? "CONFIRMED", paymentStatus: "COMPLIMENTARY", badgeType: "Faculty", createdSource: "SPEAKER_COMPANION",
      ...(over.pricingTierId ? { pricingTierId: over.pricingTierId } : {}),
    },
    select: { id: true, attendeeId: true },
  });
}

const typeOf = async (id: string) => (await db.registration.findUniqueOrThrow({ where: { id }, select: { ticketTypeId: true } })).ticketTypeId;
const textOf = async (attendeeId: string) => (await db.attendee.findUniqueOrThrow({ where: { id: attendeeId }, select: { registrationType: true } })).registrationType;

beforeEach(async () => {
  const seeded = await resetCrm();
  orgId = seeded.orgId;
  userId = seeded.userId;
  counter += 1;
  const event = await db.event.create({
    data: { organizationId: orgId, name: "Merge Test", slug: `merge-test-${counter}`, startDate: new Date("2027-01-15"), endDate: new Date("2027-01-17") },
    select: { id: true },
  });
  eventId = event.id;
  keeperId = await facultyType("Faculty", { soldCount: 34 });
  donorId = await facultyType("Faculty. ", { soldCount: 2 });
});

describe("mergeDonor", () => {
  it("moves every registration of the donor, cancelled ones included, and nothing else", async () => {
    const onKeeper = await registration(keeperId, "k@test.local");
    const live = await registration(donorId, "live@test.local");
    const cancelled = await registration(donorId, "gone@test.local", { status: "CANCELLED" });
    const delegateType = await db.ticketType.create({ data: { eventId, organizationId: orgId, name: "Physician", price: 150 }, select: { id: true } });
    const delegate = await registration(delegateType.id, "doc@test.local");
    const before = await db.registration.findUniqueOrThrow({ where: { id: live.id } });

    expect(await mergeDonor({ id: eventId, name: "Merge Test" }, { id: keeperId, name: "Faculty" }, { id: donorId, name: "Faculty. " })).toBe(2);

    expect(await typeOf(live.id)).toBe(keeperId);
    expect(await typeOf(cancelled.id)).toBe(keeperId);
    expect(await typeOf(onKeeper.id)).toBe(keeperId);
    expect(await typeOf(delegate.id)).toBe(delegateType.id);
    const after = await db.registration.findUniqueOrThrow({ where: { id: live.id } });
    expect({ ...after, ticketTypeId: null, updatedAt: null }).toEqual({ ...before, ticketTypeId: null, updatedAt: null });
  });

  it("deletes the emptied type with its rates, and moves its seat count onto the kept type only", async () => {
    await db.pricingTier.create({ data: { ticketTypeId: donorId, organizationId: orgId, name: "Standard", price: 0 } });
    const delegateType = await db.ticketType.create({ data: { eventId, organizationId: orgId, name: "Physician", price: 150, soldCount: 5 }, select: { id: true } });
    await registration(donorId, "a@test.local");

    await mergeDonor({ id: eventId, name: "Merge Test" }, { id: keeperId, name: "Faculty" }, { id: donorId, name: "Faculty. " });

    expect(await db.ticketType.findUnique({ where: { id: donorId } })).toBeNull();
    expect(await db.pricingTier.count({ where: { ticketTypeId: donorId } })).toBe(0);
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: keeperId } })).soldCount).toBe(36);
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: delegateType.id } })).soldCount).toBe(5);
    expect(await db.ticketType.count({ where: { eventId, isFaculty: true } })).toBe(1);
  });

  it("renames only a moved attendee's text that is the donor's name, trimmed and in any case", async () => {
    const exact = await registration(donorId, "exact@test.local", { typeText: "Faculty. " });
    const trimmed = await registration(donorId, "trim@test.local", { typeText: "faculty." });
    const profession = await registration(donorId, "prof@test.local", { typeText: "Physician" });
    const blank = await registration(donorId, "blank@test.local", { typeText: null });
    // Same text, but not a moved row: on the kept type already, so untouched.
    const bystander = await registration(keeperId, "by@test.local", { typeText: "Faculty." });

    await mergeDonor({ id: eventId, name: "Merge Test" }, { id: keeperId, name: "Faculty" }, { id: donorId, name: "Faculty. " });

    expect(await textOf(exact.attendeeId)).toBe("Faculty");
    expect(await textOf(trimmed.attendeeId)).toBe("Faculty");
    expect(await textOf(profession.attendeeId)).toBe("Physician");
    expect(await textOf(blank.attendeeId)).toBeNull();
    expect(await textOf(bystander.attendeeId)).toBe("Faculty.");
  });

  it("writes one audit row that can put the type back: the whole row, its rates, who moved, who was renamed", async () => {
    await db.pricingTier.create({ data: { ticketTypeId: donorId, organizationId: orgId, name: "Standard", price: 0 } });
    const moved = await registration(donorId, "a@test.local", { typeText: "Faculty." });

    await mergeDonor({ id: eventId, name: "Merge Test" }, { id: keeperId, name: "Faculty" }, { id: donorId, name: "Faculty. " });

    const rows = await db.auditLog.findMany({ where: { eventId, action: "FACULTY_TYPES_MERGED" } });
    expect(rows).toHaveLength(1);
    const changes = rows[0].changes as { kept: { id: string }; deleted: { id: string; name: string; soldCount: number; pricingTiers: { name: string }[] }; movedRegistrationIds: string[]; renamedAttendeeIds: string[] };
    expect(rows[0].entityId).toBe(keeperId);
    expect(changes.kept.id).toBe(keeperId);
    expect(changes.deleted).toMatchObject({ id: donorId, name: "Faculty. ", soldCount: 2 });
    expect(changes.deleted.pricingTiers.map((t) => t.name)).toEqual(["Standard"]);
    expect(changes.movedRegistrationIds).toEqual([moved.id]);
    expect(changes.renamedAttendeeIds).toEqual([moved.attendeeId]);
  });

  it("changes nothing at all when something points at the donor by the time it runs", async () => {
    const tier = await db.pricingTier.create({ data: { ticketTypeId: donorId, organizationId: orgId, name: "Standard", price: 0 }, select: { id: true } });
    const priced = await registration(donorId, "a@test.local", { pricingTierId: tier.id });

    await expect(mergeDonor({ id: eventId, name: "Merge Test" }, { id: keeperId, name: "Faculty" }, { id: donorId, name: "Faculty. " })).rejects.toThrow(/something now points at/);

    expect(await typeOf(priced.id)).toBe(donorId);
    expect(await db.ticketType.findUnique({ where: { id: donorId } })).not.toBeNull();
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: keeperId } })).soldCount).toBe(34);
    expect(await db.auditLog.count({ where: { eventId, action: "FACULTY_TYPES_MERGED" } })).toBe(0);
  });
});

// Review of 9a57f2a5: Registration.ticketTypeId is ON DELETE SET NULL. A
// companion registration committed on the donor between the move and the
// delete had its type blanked by the delete, with the script printing "done".
// The merge now locks the donor first, so it waits for a registration already
// being written and then moves it with the rest.
describe("a registration being made on the donor while the merge runs", () => {
  it("is moved with the others, never left with no type", async () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let finishInsert!: () => void;
    const held = new Promise<void>((resolve) => { finishInsert = resolve; });

    // A second connection inserts on the donor and stays open, as a speaker
    // being added at that moment would.
    const inserting = db.$transaction(
      async (tx) => {
        const attendee = await tx.attendee.create({ data: { organizationId: orgId, email: "late@test.local", firstName: "L", lastName: "Ate" }, select: { id: true } });
        const reg = await tx.registration.create({
          data: { organizationId: orgId, eventId, attendeeId: attendee.id, ticketTypeId: donorId, serialId: 9001, status: "CONFIRMED", paymentStatus: "COMPLIMENTARY", createdSource: "SPEAKER_COMPANION" },
          select: { id: true },
        });
        await held;
        return reg.id;
      },
      { timeout: 20000 },
    );
    await pause(400);
    const merging = mergeDonor({ id: eventId, name: "Merge Test" }, { id: keeperId, name: "Faculty" }, { id: donorId, name: "Faculty. " });
    await pause(600);
    // The merge is waiting on the lock: the donor is still there.
    expect(await db.ticketType.findUnique({ where: { id: donorId }, select: { id: true } })).not.toBeNull();
    finishInsert();
    const lateId = await inserting;
    expect(await merging).toBe(1);

    expect(await typeOf(lateId)).toBe(keeperId);
    expect(await db.registration.count({ where: { eventId, ticketTypeId: null } })).toBe(0);
    expect(await db.ticketType.findUnique({ where: { id: donorId } })).toBeNull();
  });
});

describe("referencesTo", () => {
  const none = { ratesInUse: 0, promoCodes: 0, shareLinks: 0, scheduledEmails: 0, inEventSettings: false };

  it("finds nothing on a type nobody points at", async () => {
    await registration(donorId, "a@test.local");
    expect(await referencesTo(db, eventId, donorId)).toEqual(none);
  });

  it("finds a registration priced on one of its rates, even one sitting on another type", async () => {
    const tier = await db.pricingTier.create({ data: { ticketTypeId: donorId, organizationId: orgId, name: "Standard", price: 0 }, select: { id: true } });
    await registration(keeperId, "a@test.local", { pricingTierId: tier.id });
    expect(await referencesTo(db, eventId, donorId)).toEqual({ ...none, ratesInUse: 1 });
    expect(await referencesTo(db, eventId, keeperId)).toEqual(none);
  });

  it("finds a promo code limited to it and a shared view filtered on it", async () => {
    const promo = await db.promoCode.create({
      data: { eventId, organizationId: orgId, code: "FAC", discountType: "PERCENTAGE", discountValue: 100 },
      select: { id: true },
    });
    await db.promoCodeTicketType.create({ data: { promoCodeId: promo.id, ticketTypeId: donorId } });
    await db.registrationShareLink.create({
      data: { eventId, organizationId: orgId, label: "Faculty list", token: `tok-${counter}`, ticketTypeIds: [donorId], createdById: userId, updatedById: userId },
    });
    expect(await referencesTo(db, eventId, donorId)).toEqual({ ...none, promoCodes: 1, shareLinks: 1 });
    expect(donorBlocks(await referencesTo(db, eventId, donorId))).toHaveLength(2);
  });

  it("finds a scheduled email still to go, and not one already sent", async () => {
    const email = (status: "PENDING" | "SENT") =>
      db.scheduledEmail.create({
        data: {
          eventId, organizationId: orgId, createdById: userId, recipientType: "registrations", emailType: "custom",
          filters: { ticketTypeId: donorId }, scheduledFor: new Date("2027-01-01"), status,
        },
      });
    await email("SENT");
    expect((await referencesTo(db, eventId, donorId)).scheduledEmails).toBe(0);
    await email("PENDING");
    expect((await referencesTo(db, eventId, donorId)).scheduledEmails).toBe(1);
  });

  it("finds its id in the event's settings (the DTCM section map)", async () => {
    await db.event.update({ where: { id: eventId }, data: { settings: { dtcm: { sections: { [donorId]: { area: "A", priceTypeCode: "X" } } } } } });
    expect((await referencesTo(db, eventId, donorId)).inEventSettings).toBe(true);
    expect((await referencesTo(db, eventId, keeperId)).inEventSettings).toBe(false);
  });
});
