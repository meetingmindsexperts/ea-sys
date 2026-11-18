/**
 * Reads that decide whether something may be DESTROYED, under a real row
 * policy (the sweep of Nov 18, 2026).
 *
 * A read made outside a tenant lane usually shows an empty page. One that
 * answers "is anything still using this?" does worse: it reads "no", and the
 * thing is destroyed. Each case here was such a read, found by going through
 * every place that deletes a file or refuses a removal, and each had passed
 * every unit test, because a mocked database returns what it is told. Run as
 * the non-owner app_user through pgbouncer, as the app runs:
 *
 *   - the two cleanup jobs ask, with NO lane (they walk a folder every
 *     organisation uploads into), whether a file is still claimed. They must
 *     see the claim, whoever's it is;
 *   - saving an organisation's sponsor tiers is called by its route with no
 *     lane, and must still refuse to remove a tier a sponsor holds.
 *
 * Fixtures are seeded HERE, as the owner, on the shared seed's events.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db, operatorSeesEveryTenant } from "@/lib/db";
import { getTenantOrgId, runWithTenant } from "@/lib/tenant-context";
import { supportingDocumentIsClaimed } from "@/lib/supporting-document-prune-worker";
import { referencedAttachmentPaths } from "@/lib/email-attachment-prune-worker";
import { saveSponsorTiers } from "@/services/sponsor-tier-service";
import { EVENT_A_SHARED_ID, EVENT_B_SHARED_ID, ORG_A_ID, ORG_B_ID, REG_A_ID, REG_B_ID, UPLOADER_A_ID, UPLOADER_B_ID } from "./constants";

const LETTER_A = "/uploads/resident-letters/tenancy-ev-a-shared/tenancy-guard-a.pdf";
const LETTER_B = "/uploads/resident-letters/tenancy-ev-b-shared/tenancy-guard-b.pdf";
const LETTER_NOBODY = "/uploads/resident-letters/tenancy-ev-a-shared/tenancy-guard-unclaimed.pdf";
const ATTACHMENT_A = "/uploads/email-attachments/tenancy-ev-a-shared/guard-a.pdf";
const ATTACHMENT_B = "/uploads/email-attachments/tenancy-ev-b-shared/guard-b.pdf";
const ATTACHMENT_SENT = "/uploads/email-attachments/tenancy-ev-a-shared/guard-sent.pdf";
const SEND_A = "tenancy-guard-send-a";
const SEND_B = "tenancy-guard-send-b";
const SEND_DONE = "tenancy-guard-send-done";
const SPONSOR_A = "tenancy-guard-sponsor-a";
const TIER = { key: "tenancy-guard-tier", label: "Guard tier" };

let owner: PrismaClient;
let lettersBefore: { id: string; supportingDocumentUrl: string | null }[] = [];
const startedAt = new Date();
let settingsBeforeA: unknown;
let settingsBeforeB: unknown;

beforeAll(async () => {
  process.env.RLS_SET_LOCAL = "1";
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL (owner, raw :5432) is required to seed fixtures");
  owner = new PrismaClient({ datasources: { db: { url } } });

  lettersBefore = await owner.registration.findMany({ where: { id: { in: [REG_A_ID, REG_B_ID] } }, select: { id: true, supportingDocumentUrl: true } });
  await owner.registration.update({ where: { id: REG_A_ID }, data: { supportingDocumentUrl: LETTER_A } });
  await owner.registration.update({ where: { id: REG_B_ID }, data: { supportingDocumentUrl: LETTER_B } });

  await owner.scheduledEmail.deleteMany({ where: { id: { in: [SEND_A, SEND_B, SEND_DONE] } } });
  const send = { recipientType: "registrations", emailType: "custom", scheduledFor: new Date("2030-01-01T00:00:00Z") };
  const file = (storedPath: string) => [{ name: "guard.pdf", storedPath, contentType: "application/pdf", size: 1 }];
  await owner.scheduledEmail.createMany({
    data: [
      { id: SEND_A, eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, createdById: UPLOADER_A_ID, status: "PENDING", attachments: file(ATTACHMENT_A), ...send },
      { id: SEND_B, eventId: EVENT_B_SHARED_ID, organizationId: ORG_B_ID, createdById: UPLOADER_B_ID, status: "FAILED", attachments: file(ATTACHMENT_B), ...send },
      // Already sent: nothing will read its file again, so it protects nothing.
      { id: SEND_DONE, eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, createdById: UPLOADER_A_ID, status: "SENT", attachments: file(ATTACHMENT_SENT), ...send },
    ],
  });

  // BOTH organisations have a custom tier with the SAME key. Only A has a sponsor on it.
  const withTier = async (id: string) => {
    const org = await owner.organization.findUniqueOrThrow({ where: { id }, select: { settings: true } });
    await owner.organization.update({
      where: { id },
      data: { settings: { ...((org.settings as Record<string, unknown> | null) ?? {}), sponsorTiers: [TIER] } },
    });
    return org.settings;
  };
  settingsBeforeA = await withTier(ORG_A_ID);
  settingsBeforeB = await withTier(ORG_B_ID);
  await owner.sponsor.deleteMany({ where: { id: SPONSOR_A } });
  await owner.sponsor.create({ data: { id: SPONSOR_A, eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, name: "Guard sponsor", tier: TIER.key } });
});

afterAll(async () => {
  // Each undone whatever happens to the others: a fixture left behind breaks
  // the NEXT run's seed (a queued send points at a user the seed deletes).
  const undo: (() => Promise<unknown>)[] = [
    () => owner.sponsor.deleteMany({ where: { id: SPONSOR_A } }),
    () => owner.organization.update({ where: { id: ORG_A_ID }, data: { settings: (settingsBeforeA ?? {}) as object } }),
    () => owner.organization.update({ where: { id: ORG_B_ID }, data: { settings: (settingsBeforeB ?? {}) as object } }),
    () => owner.scheduledEmail.deleteMany({ where: { id: { in: [SEND_A, SEND_B, SEND_DONE] } } }),
    ...lettersBefore.map((row) => () => owner.registration.update({ where: { id: row.id }, data: { supportingDocumentUrl: row.supportingDocumentUrl } })),
    // The audit rows this file's own saves wrote, and only those.
    () => owner.auditLog.deleteMany({ where: { entityType: "Organization", entityId: { in: [ORG_A_ID, ORG_B_ID] }, userId: { in: [UPLOADER_A_ID, UPLOADER_B_ID] }, createdAt: { gte: startedAt } } }),
  ];
  const failures: unknown[] = [];
  for (const step of undo) await step().catch((error) => failures.push(error));
  await owner.$disconnect();
  if (failures.length > 0) throw failures[0];
});

describe("the fixtures are invisible to the tenant client with no lane (or the cases below prove nothing)", () => {
  it("no lane: the claimed letter and the queued sends cannot be seen", async () => {
    expect(getTenantOrgId()).toBeNull();
    expect(await db.registration.findFirst({ where: { supportingDocumentUrl: LETTER_A }, select: { id: true } })).toBeNull();
    expect(await db.scheduledEmail.count({ where: { id: { in: [SEND_A, SEND_B] } } })).toBe(0);
    expect(await db.sponsor.count({ where: { id: SPONSOR_A } })).toBe(0);
  });
});

describe("the privileged client really is privileged here", () => {
  it("row security does not bind it on the tables the cleanups ask about", async () => {
    for (const table of ["Registration", "ScheduledEmail", "Attendee", "Speaker", "Contact"]) {
      expect(await operatorSeesEveryTenant(table), table).toBe(true);
    }
  });
});

describe("supporting-document cleanup: is this file claimed by any registration?", () => {
  it("with no lane, a file claimed in either organisation is seen as claimed", async () => {
    expect(await supportingDocumentIsClaimed(LETTER_A)).toBe(true);
    expect(await supportingDocumentIsClaimed(LETTER_B)).toBe(true);
  });

  it("a file nobody claims is still unclaimed (the job must go on collecting)", async () => {
    expect(await supportingDocumentIsClaimed(LETTER_NOBODY)).toBe(false);
  });

  it("the answer does not depend on whose lane happens to be open", async () => {
    expect(await runWithTenant(ORG_A_ID, () => supportingDocumentIsClaimed(LETTER_B))).toBe(true);
  });
});

describe("email-attachment cleanup: which files does a queued send still need?", () => {
  it("with no lane, the files of queued sends in both organisations are kept", async () => {
    const kept = await referencedAttachmentPaths();
    expect(kept.has(ATTACHMENT_A)).toBe(true);
    expect(kept.has(ATTACHMENT_B)).toBe(true);
  });

  it("the file of a send that has already gone is not kept", async () => {
    expect((await referencedAttachmentPaths()).has(ATTACHMENT_SENT)).toBe(false);
  });
});

describe("sponsor tiers: a tier a sponsor holds cannot be removed", () => {
  it("called with no lane, as its route calls it, removing a held tier is refused", async () => {
    expect(getTenantOrgId()).toBeNull();
    const result = await saveSponsorTiers({ organizationId: ORG_A_ID, actorUserId: UPLOADER_A_ID, tiers: [] });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("TIER_IN_USE");
    const after = await owner.organization.findUniqueOrThrow({ where: { id: ORG_A_ID }, select: { settings: true } });
    expect((after.settings as { sponsorTiers?: unknown[] }).sponsorTiers).toEqual([TIER]);
  });

  it("another organisation's sponsor on the SAME tier key does not hold this organisation's tier", async () => {
    // Org B has the same tier key and no sponsor on it. Org A's sponsor holds
    // that key in A. If the count leaked across organisations, B's removal
    // would be refused; it must go through, and A's tier must be untouched.
    const result = await saveSponsorTiers({ organizationId: ORG_B_ID, actorUserId: UPLOADER_B_ID, tiers: [] });
    expect(result.ok).toBe(true);
    const b = await owner.organization.findUniqueOrThrow({ where: { id: ORG_B_ID }, select: { settings: true } });
    expect((b.settings as { sponsorTiers?: unknown[] }).sponsorTiers).toEqual([]);
    const a = await owner.organization.findUniqueOrThrow({ where: { id: ORG_A_ID }, select: { settings: true } });
    expect((a.settings as { sponsorTiers?: unknown[] }).sponsorTiers).toEqual([TIER]);
  });
});
