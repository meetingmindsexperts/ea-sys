/**
 * Erasing or exporting a CRM contact never reaches a look-alike address
 * (Nov 11, 2026), on a REAL Postgres.
 *
 * The privacy service picked a person's conversations with
 * `{ equals: address, mode: "insensitive" }`. Prisma compiles that to ILIKE,
 * where `_` matches any one character, so john_smith@ also matched
 * john.smith@: the export handed over another person's emails and the
 * erasure deleted them, which cannot be undone. A mocked Prisma returns
 * whatever it is told, so only the database can show this.
 *
 * Run: INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "@/lib/db";
import { eraseCrmContact, exportCrmContactData } from "@/crm/services/crm-privacy-service";
import { resetCrm, type CrmSeed } from "./helper";

const THEIRS = "john_smith@abbott.com";
const LOOK_ALIKE = "john.smith@abbott.com";

let seed: CrmSeed;
let contactId: string;
let tokens = 0;

async function contact(email: string): Promise<string> {
  const row = await db.crmContact.create({
    // Stored in mixed case on purpose: the match must still ignore case.
    data: { organizationId: seed.orgId, firstName: "John", lastName: "Smith", email: email.replace("john", "John"), emailKey: email },
    select: { id: true },
  });
  return row.id;
}

/** An unlinked thread (a captured one), with one message from each given sender. */
async function thread(counterpartyEmail: string, senders: string[]): Promise<string> {
  tokens += 1;
  const row = await db.crmEmailThread.create({
    data: {
      organizationId: seed.orgId,
      subject: "Sponsorship",
      replyToken: `erasure-tok-${tokens}`,
      counterpartyEmail,
      messages: { create: senders.map((fromEmail) => ({ organizationId: seed.orgId, direction: "INBOUND" as const, fromEmail })) },
    },
    select: { id: true },
  });
  return row.id;
}

const sendersOn = async (threadId: string) =>
  (await db.crmEmailMessage.findMany({ where: { threadId }, select: { fromEmail: true } })).map((m) => m.fromEmail).sort();

beforeEach(async () => {
  seed = await resetCrm();
  contactId = await contact(THEIRS);
  await contact(LOOK_ALIKE);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("a CRM contact whose address has an underscore", () => {
  it("the export holds their conversations and never a look-alike's", async () => {
    const theirs = await thread(THEIRS, [THEIRS]);
    await thread(LOOK_ALIKE, [LOOK_ALIKE]);

    const res = await exportCrmContactData({ organizationId: seed.orgId, crmContactId: contactId });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.emailThreads.map((t) => t.id)).toEqual([theirs]);
  });

  it("the erasure removes their conversations and messages, and leaves the look-alike's in place", async () => {
    const theirs = await thread(THEIRS, [THEIRS]);
    const lookAlikes = await thread(LOOK_ALIKE, [LOOK_ALIKE]);
    // Someone else's conversation both of them wrote on (a reply-all each).
    const shared = await thread("procurement@abbott.com", ["procurement@abbott.com", THEIRS, LOOK_ALIKE]);

    const res = await eraseCrmContact({
      organizationId: seed.orgId,
      crmContactId: contactId,
      userId: seed.userId,
      confirmEmail: THEIRS,
      source: "rest",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Their one thread, its one message, and their one message on the shared thread.
    expect(res.report.erased).toMatchObject({ emailThreads: 1, emailMessages: 2 });
    expect(await db.crmEmailThread.findUnique({ where: { id: theirs }, select: { id: true } })).toBeNull();
    // Until Nov 11, 2026 both of these were deleted with them.
    expect(await sendersOn(lookAlikes)).toEqual([LOOK_ALIKE]);
    expect(await sendersOn(shared)).toEqual([LOOK_ALIKE, "procurement@abbott.com"]);
    expect(await db.crmContact.count({ where: { organizationId: seed.orgId } })).toBe(1);
  });
});
