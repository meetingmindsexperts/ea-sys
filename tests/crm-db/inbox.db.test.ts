/**
 * CRM inbox — REAL-Postgres integration tests.
 *
 * These pin the exact things the mocked unit suite cannot: the s3Key UNIQUE
 * constraint actually rejects (H2), recordOutboundEmail actually writes a
 * thread with a rolling expiry, the append is org-bound in the DB, and
 * archiving a deal actually revokes its tokens (M1) + the junction carries
 * organizationId. If the constraint/transaction were wrong, a mock would still
 * pass — Postgres won't.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { resetCrm, seedDeal, type CrmSeed } from "./helper";
import { recordOutboundEmail } from "@/crm/services/crm-email-thread-service";
import { setDealArchived, addDealContact } from "@/crm/services/deal-service";

let seed: CrmSeed;

beforeEach(async () => {
  seed = await resetCrm();
});

afterAll(async () => {
  await db.$disconnect();
});

async function outbound(over: Partial<Parameters<typeof recordOutboundEmail>[0]> = {}) {
  await recordOutboundEmail({
    organizationId: seed.orgId,
    dealId: null,
    crmContactId: null,
    counterpartyEmail: "Jane@Abbott.com",
    counterpartyName: "Jane Doe",
    subject: "Sponsorship",
    htmlBody: "<p>hi</p>",
    textBody: "hi",
    replyToken: `tok${Math.abs(Math.floor(performance.now() * 1000))}`,
    providerMessageId: "ses-1",
    sentByUserId: seed.userId,
    fromEmail: "events@mmg.com",
    fromName: "MMG",
    ...over,
  });
}

describe("recordOutboundEmail (real DB)", () => {
  it("creates a thread + first message, lowercases the counterparty, sets a rolling expiry", async () => {
    await outbound({ replyToken: "tok-a", dealId: null });
    const thread = await db.crmEmailThread.findUnique({
      where: { replyToken: "tok-a" },
      include: { messages: true },
    });
    expect(thread).not.toBeNull();
    expect(thread!.counterpartyEmail).toBe("jane@abbott.com"); // lowercased
    expect(thread!.messages).toHaveLength(1);
    expect(thread!.messages[0].direction).toBe("OUTBOUND");
    // M1: expiry set ~180 days out.
    expect(thread!.expiresAt).not.toBeNull();
    const days = (thread!.expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(179);
    expect(days).toBeLessThan(181);
  });

  it("append mode is ORG-BOUND — a foreign threadId records nothing", async () => {
    await outbound({ replyToken: "tok-b" });
    const thread = await db.crmEmailThread.findUnique({ where: { replyToken: "tok-b" }, select: { id: true } });

    const otherOrg = await resetCrmOtherOrg();
    // Append to our thread but claiming the OTHER org — must no-op.
    await recordOutboundEmail({
      organizationId: otherOrg,
      dealId: null,
      crmContactId: null,
      counterpartyEmail: "x@y.com",
      counterpartyName: null,
      subject: "hijack",
      htmlBody: "<p>x</p>",
      textBody: "x",
      replyToken: "unused",
      providerMessageId: null,
      sentByUserId: null,
      fromEmail: "a@b.com",
      fromName: null,
      threadId: thread!.id,
    });
    const count = await db.crmEmailMessage.count({ where: { threadId: thread!.id } });
    expect(count).toBe(1); // still just the original — the cross-org append was dropped
  });
});

describe("s3Key uniqueness (H2 — real constraint)", () => {
  it("a second inbound message with the same s3Key is rejected (P2002), never double-filed", async () => {
    await outbound({ replyToken: "tok-c" });
    const thread = await db.crmEmailThread.findUnique({ where: { replyToken: "tok-c" }, select: { id: true } });

    const base = {
      organizationId: seed.orgId,
      threadId: thread!.id,
      direction: "INBOUND" as const,
      fromEmail: "jane@abbott.com",
      s3Key: "processed/dup",
    };
    await db.crmEmailMessage.create({ data: base });

    let code: string | undefined;
    try {
      await db.crmEmailMessage.create({ data: base });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) code = err.code;
    }
    expect(code).toBe("P2002");

    // Outbound rows (s3Key NULL) are distinct — many can coexist.
    await outbound({ replyToken: "tok-d" });
    await outbound({ replyToken: "tok-e" });
    const nulls = await db.crmEmailMessage.count({ where: { s3Key: null } });
    expect(nulls).toBeGreaterThanOrEqual(3);
  });
});

describe("deal archive revokes tokens (M1 — real update)", () => {
  it("archiving a deal sets revokedAt on its threads; restore clears it", async () => {
    const { dealId } = await seedDeal(seed);
    await outbound({ replyToken: "tok-f", dealId });

    await setDealArchived({ dealId, organizationId: seed.orgId, userId: seed.userId, source: "rest", archived: true });
    // revoke is fire-and-forget (void) — poll briefly for the write to land.
    await waitFor(async () => (await tokenRevokedAt("tok-f")) !== null);
    expect(await tokenRevokedAt("tok-f")).not.toBeNull();

    await setDealArchived({ dealId, organizationId: seed.orgId, userId: seed.userId, source: "rest", archived: false });
    await waitFor(async () => (await tokenRevokedAt("tok-f")) === null);
    expect(await tokenRevokedAt("tok-f")).toBeNull();
  });
});

describe("junction organizationId (multi-tenant prep — real row)", () => {
  it("addDealContact writes organizationId on the CrmDealContact row", async () => {
    const { dealId, contactId } = await seedDeal(seed);
    const res = await addDealContact({
      dealId,
      crmContactId: contactId,
      organizationId: seed.orgId,
      userId: seed.userId,
      source: "rest",
    });
    expect(res.ok).toBe(true);
    const row = await db.crmDealContact.findFirst({ where: { dealId, crmContactId: contactId } });
    expect(row!.organizationId).toBe(seed.orgId);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function tokenRevokedAt(replyToken: string): Promise<Date | null> {
  const t = await db.crmEmailThread.findUnique({ where: { replyToken }, select: { revokedAt: true } });
  return t?.revokedAt ?? null;
}

async function resetCrmOtherOrg(): Promise<string> {
  const org = await db.organization.create({
    data: { name: "Other Org", slug: `other-${Math.abs(Math.floor(performance.now()))}`, companyName: "Other" },
    select: { id: true },
  });
  return org.id;
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
