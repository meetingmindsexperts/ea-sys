/**
 * An underscore in an address is not a wildcard (review of ed074639, Nov 10,
 * 2026), on a REAL Postgres.
 *
 * Prisma compiles `{ equals, mode: "insensitive" }` to ILIKE, where `_`
 * matches any one character. The rule for whose a record is compared
 * addresses that way, so a confirmed account on john_smith@... claimed the
 * unclaimed records of john.smith@..., for good. A mocked Prisma returns
 * whatever it is told, so only the database can show this.
 *
 * Run: INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { linkConfirmedSpeakers, speakerClaimPending } from "@/lib/registrant-access";
import { reviewerSpeakerRecords } from "@/lib/abstract-reviewer-notify";
import { resetCrm } from "./helper";

let orgId: string;
let eventId: string;
let counter = 0;

async function speaker(email: string, over: { userId?: string; additionalEmail?: string } = {}): Promise<string> {
  const row = await db.speaker.create({
    data: { eventId, organizationId: orgId, email, firstName: "Sam", lastName: "Speaker", title: "DR", ...over },
    select: { id: true },
  });
  return row.id;
}

async function account(email: string): Promise<string> {
  const user = await db.user.create({
    data: { email, passwordHash: "x", firstName: "Acc", lastName: "Ount", role: "REGISTRANT", emailConfirmedAt: new Date() },
    select: { id: true },
  });
  return user.id;
}

const owner = async (id: string) => (await db.speaker.findUniqueOrThrow({ where: { id }, select: { userId: true } })).userId;

beforeEach(async () => {
  const seeded = await resetCrm();
  orgId = seeded.orgId;
  counter += 1;
  const event = await db.event.create({
    data: { organizationId: orgId, name: "Wildcard Test", slug: `wildcard-test-${counter}`, startDate: new Date("2027-01-15"), endDate: new Date("2027-01-17") },
    select: { id: true },
  });
  eventId = event.id;
});

describe("an address with an underscore", () => {
  it("claims its own records, in any case, and never a look-alike's", async () => {
    const lookAlikeDot = await speaker("john.smith@test.local");
    const lookAlikeDash = await speaker("john-smith@test.local");
    const userId = await account("john_smith@test.local");
    const scope = { userId, email: "john_smith@test.local", confirmed: true };

    expect(await linkConfirmedSpeakers(scope)).toBe(0);
    expect(await owner(lookAlikeDot)).toBeNull();
    expect(await owner(lookAlikeDash)).toBeNull();

    // A second event holds the person's own record, typed in capitals by the organiser.
    counter += 1;
    const other = await db.event.create({
      data: { organizationId: orgId, name: "Own Record", slug: `wildcard-test-${counter}`, startDate: new Date("2027-02-15"), endDate: new Date("2027-02-17") },
      select: { id: true },
    });
    const own = await db.speaker.create({
      data: { eventId: other.id, organizationId: orgId, email: "John_Smith@Test.Local", firstName: "John", lastName: "Smith" },
      select: { id: true },
    });
    expect(await linkConfirmedSpeakers(scope)).toBe(1);
    expect(await owner(own.id)).toBe(userId);
  });

  it("an unconfirmed look-alike is not told a record is waiting on its address", async () => {
    await speaker("john.smith@test.local");
    expect(await speakerClaimPending(eventId, "john_smith@test.local", false)).toBe(false);
    expect(await speakerClaimPending(eventId, "JOHN.SMITH@test.local", false)).toBe(true);
  });

  it("a reviewer's emails never copy a look-alike's additional email", async () => {
    await speaker("rev.one@test.local", { additionalEmail: "someone-else@test.local" });
    const userId = await account("rev_one@test.local");
    const records = await reviewerSpeakerRecords(eventId, [{ id: userId, email: "rev_one@test.local" }]);
    expect(records.get(userId)).toBeUndefined();
  });

  it("nor a record on their own address that another account has claimed", async () => {
    const otherAccount = await account("claimed-by@test.local");
    await speaker("rev@test.local", { userId: otherAccount, additionalEmail: "their-assistant@test.local" });
    const userId = await account("rev@test.local");
    const records = await reviewerSpeakerRecords(eventId, [{ id: userId, email: "rev@test.local" }]);
    expect(records.get(userId)).toBeUndefined();
  });
});
