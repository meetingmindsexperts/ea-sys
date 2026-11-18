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
import { db } from "@/lib/db";
import { getTenantOrgId, runWithTenant } from "@/lib/tenant-context";
import { supportingDocumentIsClaimed } from "@/lib/supporting-document-prune-worker";
import { referencedAttachmentPaths } from "@/lib/email-attachment-prune-worker";
import { saveSponsorTiers } from "@/services/sponsor-tier-service";
import { EVENT_A_SHARED_ID, EVENT_B_SHARED_ID, ORG_A_ID, ORG_B_ID, REG_A_ID, REG_B_ID, UPLOADER_A_ID, UPLOADER_B_ID } from "./constants";

const LETTER_A = "/uploads/supporting-documents/tenancy-guard-a.pdf";
const LETTER_B = "/uploads/supporting-documents/tenancy-guard-b.pdf";
const LETTER_NOBODY = "/uploads/supporting-documents/tenancy-guard-unclaimed.pdf";
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
let settingsBefore: unknown;

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

  const org = await owner.organization.findUniqueOrThrow({ where: { id: ORG_A_ID }, select: { settings: true } });
  settingsBefore = org.settings;
  await owner.organization.update({
    where: { id: ORG_A_ID },
    data: { settings: { ...((org.settings as Record<string, unknown> | null) ?? {}), sponsorTiers: [TIER] } },
  });
  await owner.sponsor.deleteMany({ where: { id: SPONSOR_A } });
  await owner.sponsor.create({ data: { id: SPONSOR_A, eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, name: "Guard sponsor", tier: TIER.key } });
});

afterAll(async () => {
  await owner.sponsor.deleteMany({ where: { id: SPONSOR_A } });
  await owner.organization.update({ where: { id: ORG_A_ID }, data: { settings: (settingsBefore ?? {}) as object } });
  await owner.scheduledEmail.deleteMany({ where: { id: { in: [SEND_A, SEND_B, SEND_DONE] } } });
  for (const row of lettersBefore) await owner.registration.update({ where: { id: row.id }, data: { supportingDocumentUrl: row.supportingDocumentUrl } });
  await owner.$disconnect();
});

describe("the fixtures are invisible to the tenant client with no lane (or the cases below prove nothing)", () => {
  it("no lane: the claimed letter and the queued sends cannot be seen", async () => {
    expect(getTenantOrgId()).toBeNull();
    expect(await db.registration.findFirst({ where: { supportingDocumentUrl: LETTER_A }, select: { id: true } })).toBeNull();
    expect(await db.scheduledEmail.count({ where: { id: { in: [SEND_A, SEND_B] } } })).toBe(0);
    expect(await db.sponsor.count({ where: { id: SPONSOR_A } })).toBe(0);
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

  it("another organisation's sponsors do not hold this organisation's tiers", async () => {
    // Org B has no sponsor on the key: its own list saves, and org A's sponsor does not count against it.
    const result = await saveSponsorTiers({ organizationId: ORG_B_ID, actorUserId: UPLOADER_B_ID, tiers: [] });
    expect(result.ok).toBe(true);
  });
});
