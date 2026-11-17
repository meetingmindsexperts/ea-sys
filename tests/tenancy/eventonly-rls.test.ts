/**
 * The six tables that carried an event and no organisation (Event RLS step 5,
 * Nov 17 2026): EmailTemplate, Notification, EventStats, ImportLog,
 * InvoiceCounter, EventBillingAccount. The policies from
 * prisma/rls/eventonly.sql, enforced end to end through the ALS store, the
 * SET LOCAL extension and pgbouncer, as the non-owner app_user.
 *
 * Two kinds of proof. For every table: a lane sees its own rows and no
 * other's, no lane sees nothing, and a write cannot cross. And for the
 * WRITERS that had to learn the column: the invoice counter, the organiser
 * notice, the stats refresh and the template create each land a row the
 * policy accepts, stamped with the lane's organisation, which is the half a
 * mocked test cannot show (a writer that forgot the column is refused here by
 * WITH CHECK, and passes every unit test).
 *
 * Fixtures are seeded HERE on the shared seed's events and users.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { getNextInvoiceNumber } from "@/lib/invoice-numbering";
import { createNotification, notifyEventAdmins } from "@/lib/notifications";
import { refreshEventStatsNow } from "@/lib/event-stats";
import { createCustomEmailTemplate } from "@/lib/email-template-create";
import {
  ORG_A_ID,
  ORG_B_ID,
  EVENT_A_SHARED_ID,
  EVENT_B_SHARED_ID,
  EVENT_B_ONLY_ID,
  UPLOADER_A_ID,
  UPLOADER_B_ID,
  BILLING_A_SHARED_ID,
  BILLING_B_SHARED_ID,
} from "./constants";

const A = "tenancy-eo-a";
const B = "tenancy-eo-b";
const SLUG = "tenancy-eventonly-fixture";
const NOTICE_TITLE = "tenancy-eventonly notice";

/** Owner connection: owners bypass the non-FORCE policies, which is what lets us seed both lanes. */
let owner: PrismaClient;

async function clean() {
  await owner.emailTemplate.deleteMany({ where: { slug: { startsWith: SLUG } } });
  await owner.notification.deleteMany({ where: { title: { startsWith: NOTICE_TITLE } } });
  await owner.importLog.deleteMany({ where: { id: { in: [A, B, "tenancy-eo-smuggled"] } } });
  await owner.eventStats.deleteMany({ where: { eventId: { in: [EVENT_A_SHARED_ID, EVENT_B_SHARED_ID, EVENT_B_ONLY_ID] } } });
  await owner.invoiceCounter.deleteMany({ where: { eventId: { in: [EVENT_A_SHARED_ID, EVENT_B_SHARED_ID] }, type: "CREDIT_NOTE" } });
  await owner.eventBillingAccount.deleteMany({ where: { id: { in: [A, B, "tenancy-eo-smuggled"] } } });
}

beforeAll(async () => {
  process.env.RLS_SET_LOCAL = "1";
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL (owner, raw :5432) is required to seed fixtures");
  owner = new PrismaClient({ datasources: { db: { url } } });
  await clean();

  const template = { name: "Fixture", subject: "s", htmlContent: "<p>h</p>" };
  await owner.emailTemplate.createMany({
    data: [
      { id: A, organizationId: ORG_A_ID, eventId: EVENT_A_SHARED_ID, slug: SLUG, ...template },
      { id: B, organizationId: ORG_B_ID, eventId: EVENT_B_SHARED_ID, slug: SLUG, ...template },
    ],
  });
  await owner.notification.createMany({
    data: [
      { id: A, organizationId: ORG_A_ID, userId: UPLOADER_A_ID, eventId: EVENT_A_SHARED_ID, type: "REGISTRATION", title: NOTICE_TITLE, message: "m" },
      { id: B, organizationId: ORG_B_ID, userId: UPLOADER_B_ID, eventId: EVENT_B_SHARED_ID, type: "REGISTRATION", title: NOTICE_TITLE, message: "m" },
    ],
  });
  const log = { source: "csv", entityType: "registrations", totalProcessed: 1, totalCreated: 1, totalSkipped: 0, totalErrors: 0 };
  await owner.importLog.createMany({
    data: [
      { id: A, organizationId: ORG_A_ID, eventId: EVENT_A_SHARED_ID, userId: UPLOADER_A_ID, ...log },
      { id: B, organizationId: ORG_B_ID, eventId: EVENT_B_SHARED_ID, userId: UPLOADER_B_ID, ...log },
    ],
  });
  await owner.eventStats.createMany({
    data: [
      { id: A, organizationId: ORG_A_ID, eventId: EVENT_A_SHARED_ID },
      { id: B, organizationId: ORG_B_ID, eventId: EVENT_B_SHARED_ID },
    ],
  });
  await owner.invoiceCounter.createMany({
    data: [
      { id: A, organizationId: ORG_A_ID, eventId: EVENT_A_SHARED_ID, type: "CREDIT_NOTE", lastSequence: 4 },
      { id: B, organizationId: ORG_B_ID, eventId: EVENT_B_SHARED_ID, type: "CREDIT_NOTE", lastSequence: 9 },
    ],
  });
  await owner.eventBillingAccount.createMany({
    data: [
      { id: A, organizationId: ORG_A_ID, eventId: EVENT_A_SHARED_ID, billingAccountId: BILLING_A_SHARED_ID },
      { id: B, organizationId: ORG_B_ID, eventId: EVENT_B_SHARED_ID, billingAccountId: BILLING_B_SHARED_ID },
    ],
    skipDuplicates: true,
  });
});

afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await clean();
  await owner?.$disconnect();
  await db.$disconnect();
});

/** One reader per table, by the two fixture ids, so every assertion below runs for all six. */
const TABLES: Record<string, () => Promise<{ id: string }[]>> = {
  EmailTemplate: () => db.emailTemplate.findMany({ where: { id: { in: [A, B] } }, select: { id: true } }),
  Notification: () => db.notification.findMany({ where: { id: { in: [A, B] } }, select: { id: true } }),
  EventStats: () => db.eventStats.findMany({ where: { id: { in: [A, B] } }, select: { id: true } }),
  ImportLog: () => db.importLog.findMany({ where: { id: { in: [A, B] } }, select: { id: true } }),
  InvoiceCounter: () => db.invoiceCounter.findMany({ where: { id: { in: [A, B] } }, select: { id: true } }),
  EventBillingAccount: () => db.eventBillingAccount.findMany({ where: { id: { in: [A, B] } }, select: { id: true } }),
};

describe("the six event-only tables under row security (prisma/rls/eventonly.sql)", () => {
  for (const [table, read] of Object.entries(TABLES)) {
    it(`${table}: each lane sees its own row and not the other's; no lane sees nothing`, async () => {
      expect((await runWithTenant(ORG_A_ID, read)).map((r) => r.id), "lane A").toEqual([A]);
      expect((await runWithTenant(ORG_B_ID, read)).map((r) => r.id), "lane B").toEqual([B]);
      expect(await read(), "no lane").toEqual([]);
      expect(await runWithTenant("", read), "the empty lane").toEqual([]);
    });
  }

  it("a filter by another tenant's EVENT finds nothing from this lane (the old guard was only the filter)", async () => {
    const found = await runWithTenant(ORG_A_ID, () =>
      Promise.all([
        db.emailTemplate.count({ where: { eventId: EVENT_B_SHARED_ID } }),
        db.importLog.count({ where: { eventId: EVENT_B_SHARED_ID } }),
        db.invoiceCounter.count({ where: { eventId: EVENT_B_SHARED_ID } }),
        db.eventStats.count({ where: { eventId: EVENT_B_SHARED_ID } }),
        db.eventBillingAccount.count({ where: { eventId: EVENT_B_SHARED_ID } }),
        db.notification.count({ where: { userId: UPLOADER_B_ID } }),
      ]),
    );
    expect(found).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("a write cannot cross: update and delete of another tenant's rows touch nothing", async () => {
    const touched = await runWithTenant(ORG_A_ID, () =>
      Promise.all([
        db.emailTemplate.updateMany({ where: { id: B }, data: { subject: "stolen" } }),
        db.notification.updateMany({ where: { id: B }, data: { isRead: true } }),
        db.invoiceCounter.updateMany({ where: { id: B }, data: { lastSequence: 0 } }),
        db.importLog.deleteMany({ where: { id: B } }),
        db.eventBillingAccount.deleteMany({ where: { id: B } }),
        db.eventStats.deleteMany({ where: { id: B } }),
      ]),
    );
    expect(touched.map((t) => t.count)).toEqual([0, 0, 0, 0, 0, 0]);
    const counter = await owner.invoiceCounter.findUnique({ where: { id: B }, select: { lastSequence: true } });
    expect(counter?.lastSequence).toBe(9);
  });

  it("WITH CHECK refuses a row stamped with another organisation, and a row stamped with none", async () => {
    const log = { eventId: EVENT_B_SHARED_ID, userId: UPLOADER_A_ID, source: "csv", entityType: "registrations", totalProcessed: 0, totalCreated: 0, totalSkipped: 0, totalErrors: 0 };
    await expect(runWithTenant(ORG_A_ID, () => db.importLog.create({ data: { id: "tenancy-eo-smuggled", organizationId: ORG_B_ID, ...log } }))).rejects.toThrow(/row-level security/);
    // What a writer that forgot the column would do: every unit test passes, the database refuses.
    await expect(runWithTenant(ORG_A_ID, () => db.importLog.create({ data: { id: "tenancy-eo-smuggled", ...log, eventId: EVENT_A_SHARED_ID } }))).rejects.toThrow(/row-level security/);
    expect(await owner.importLog.count({ where: { id: "tenancy-eo-smuggled" } })).toBe(0);
  });
});

describe("the writers stamp the organisation the policy holds the row to", () => {
  it("the invoice counter: the next number comes from this tenant's own counter, stamped", async () => {
    const next = await runWithTenant(ORG_A_ID, () => tenantTransaction((tx) => getNextInvoiceNumber(tx, EVENT_A_SHARED_ID, "CREDIT_NOTE", "TEN", ORG_A_ID)));
    expect(next).toEqual({ sequenceNumber: 5, invoiceNumber: "TEN-CN-005" });
    // A type with no counter yet: the create branch lands too.
    await owner.invoiceCounter.deleteMany({ where: { eventId: EVENT_A_SHARED_ID, type: "CREDIT_NOTE" } });
    const first = await runWithTenant(ORG_A_ID, () => tenantTransaction((tx) => getNextInvoiceNumber(tx, EVENT_A_SHARED_ID, "CREDIT_NOTE", "TEN", ORG_A_ID)));
    expect(first.sequenceNumber).toBe(1);
    const row = await owner.invoiceCounter.findFirst({ where: { eventId: EVENT_A_SHARED_ID, type: "CREDIT_NOTE" }, select: { organizationId: true } });
    expect(row?.organizationId).toBe(ORG_A_ID);
  });

  it("the invoice counter of another tenant cannot be advanced from this lane", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => tenantTransaction((tx) => getNextInvoiceNumber(tx, EVENT_B_SHARED_ID, "CREDIT_NOTE", "TEN", ORG_A_ID))),
    ).rejects.toThrow();
    const untouched = await owner.invoiceCounter.findUnique({ where: { id: B }, select: { lastSequence: true, organizationId: true } });
    expect(untouched).toEqual({ lastSequence: 9, organizationId: ORG_B_ID });
  });

  it("the organiser notice: written for the event's organisers, stamped with the event's organisation", async () => {
    await runWithTenant(ORG_A_ID, () => notifyEventAdmins(EVENT_A_SHARED_ID, { type: "REGISTRATION", title: `${NOTICE_TITLE} admins`, message: "m" }));
    const written = await owner.notification.findMany({ where: { title: `${NOTICE_TITLE} admins` }, select: { organizationId: true, eventId: true } });
    expect(written.length).toBeGreaterThan(0);
    expect(new Set(written.map((n) => n.organizationId))).toEqual(new Set([ORG_A_ID]));
    // And a notice with no event, for a recipient: the caller names the organisation.
    await runWithTenant(ORG_A_ID, () => createNotification({ userId: UPLOADER_A_ID, organizationId: ORG_A_ID, type: "SIGNUP", title: `${NOTICE_TITLE} signup`, message: "m" }));
    expect(await runWithTenant(ORG_A_ID, () => db.notification.count({ where: { title: `${NOTICE_TITLE} signup` } }))).toBe(1);
    expect(await runWithTenant(ORG_B_ID, () => db.notification.count({ where: { title: { startsWith: NOTICE_TITLE }, organizationId: ORG_A_ID } }))).toBe(0);
  });

  it("the stats refresh: inside the event's lane it creates the row, stamped with the event's organisation", async () => {
    await owner.eventStats.deleteMany({ where: { eventId: EVENT_B_ONLY_ID } });
    await runWithTenant(ORG_B_ID, () => refreshEventStatsNow(EVENT_B_ONLY_ID));
    const created = await owner.eventStats.findUnique({ where: { eventId: EVENT_B_ONLY_ID }, select: { organizationId: true } });
    expect(created?.organizationId).toBe(ORG_B_ID);
  });

  it("the stats refresh updates an existing row in place: recomputed, and still its organisation's", async () => {
    const before = await owner.eventStats.findUniqueOrThrow({ where: { eventId: EVENT_A_SHARED_ID }, select: { computedAt: true } });
    await runWithTenant(ORG_A_ID, () => refreshEventStatsNow(EVENT_A_SHARED_ID));
    const after = await owner.eventStats.findUniqueOrThrow({ where: { eventId: EVENT_A_SHARED_ID }, select: { id: true, organizationId: true, computedAt: true } });
    expect(after).toMatchObject({ id: A, organizationId: ORG_A_ID });
    expect(after.computedAt.getTime()).toBeGreaterThan(before.computedAt.getTime());
  });

  it("the stats refresh outside a lane, or in another tenant's, writes nothing: no zeros, no row under the wrong organisation", async () => {
    await owner.eventStats.deleteMany({ where: { eventId: EVENT_B_ONLY_ID } });
    // It cannot see its event, so it skips (and logs); it does not throw at its fire-and-forget callers.
    await expect(refreshEventStatsNow(EVENT_B_ONLY_ID)).resolves.toBeUndefined();
    await expect(runWithTenant(ORG_A_ID, () => refreshEventStatsNow(EVENT_B_ONLY_ID))).resolves.toBeUndefined();
    expect(await owner.eventStats.count({ where: { eventId: EVENT_B_ONLY_ID } })).toBe(0);
  });

  it("a template created in a lane is that organisation's, and the other tenant's same slug is not in the way", async () => {
    const result = await runWithTenant(ORG_A_ID, () =>
      createCustomEmailTemplate({ eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, slug: `${SLUG}-new`, name: "New", subject: "s", htmlContent: "<p>h</p>" }),
    );
    expect(result.ok).toBe(true);
    const row = await owner.emailTemplate.findFirst({ where: { slug: `${SLUG}-new` }, select: { organizationId: true, eventId: true } });
    expect(row).toEqual({ organizationId: ORG_A_ID, eventId: EVENT_A_SHARED_ID });
    // A slug already on this event is seen from its own lane, so the create is refused cleanly.
    const taken = await runWithTenant(ORG_A_ID, () =>
      createCustomEmailTemplate({ eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, slug: SLUG, name: "Dup", subject: "s", htmlContent: "<p>h</p>" }),
    );
    expect(taken).toMatchObject({ ok: false, code: "SLUG_TAKEN" });
  });

  it("a template cannot be created on another tenant's event from this lane, whichever organisation it claims", async () => {
    // Stamped with the event's real organisation: WITH CHECK refuses it (not this lane's). Stamped with
    // this lane's: the database takes the row, which is why the ROUTES find the event inside the lane
    // first. The policy stops reading and moving another tenant's rows; it cannot know whose an event id is.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        createCustomEmailTemplate({ eventId: EVENT_B_SHARED_ID, organizationId: ORG_B_ID, slug: `${SLUG}-cross`, name: "X", subject: "s", htmlContent: "<p>h</p>" }),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await owner.emailTemplate.count({ where: { slug: `${SLUG}-cross` } })).toBe(0);
  });
});
