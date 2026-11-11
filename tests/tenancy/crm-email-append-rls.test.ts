/**
 * A reply sent from the CRM inbox is recorded on its thread under row-level
 * security (Nov 11, 2026).
 *
 * recordOutboundEmail's append ran its UPDATE as `db.$executeRaw`. The tenant
 * extension wraps model operations only (src/lib/db.ts), so a raw statement on
 * the bare client carried no `app.current_org` and, fail-closed, matched no
 * thread: the reply had already gone out and nothing was stored. Invisible on
 * master, where the policies are not applied. The append now runs both
 * statements inside tenantTransaction; this proves it against the real policies
 * as the non-owner app_user.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { recordOutboundEmail } from "@/crm/services/crm-email-thread-service";
import { ORG_A_ID, ORG_B_ID, CRM_THREAD_A_ID, CRM_THREAD_B_ID } from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

let markers = 0;
/** A value no seeded message carries, so the row this test wrote can be found again. */
const marker = () => `rls-append-${process.pid}-${Date.now()}-${(markers += 1)}`;

function reply(organizationId: string, threadId: string, providerMessageId: string) {
  return recordOutboundEmail({
    organizationId,
    dealId: null,
    crmContactId: null,
    counterpartyEmail: "sponsor@example.test",
    counterpartyName: null,
    subject: "Re: Sponsorship",
    htmlBody: "<p>Thanks</p>",
    textBody: "Thanks",
    replyToken: "unused-on-append",
    providerMessageId,
    sentByUserId: null,
    fromEmail: "partnerships@example.test",
    fromName: null,
    threadId,
  });
}

const written = (orgId: string, providerMessageId: string) =>
  runWithTenant(orgId, () =>
    db.crmEmailMessage.findMany({ where: { providerMessageId }, select: { id: true, threadId: true, organizationId: true, direction: true } }),
  );

describe("recordOutboundEmail append under RLS", () => {
  it("records the reply on the tenant's own thread", async () => {
    const id = marker();
    await runWithTenant(ORG_A_ID, () => reply(ORG_A_ID, CRM_THREAD_A_ID, id));

    const rows = await written(ORG_A_ID, id);
    // Removed by its captured id whatever the assertions say: the fixtures are shared.
    await runWithTenant(ORG_A_ID, () => db.crmEmailMessage.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }));

    expect(rows).toEqual([{ id: expect.any(String), threadId: CRM_THREAD_A_ID, organizationId: ORG_A_ID, direction: "OUTBOUND" }]);
  });

  it("records nothing on another tenant's thread, whichever organisation the caller names", async () => {
    const asOwn = marker();
    const asTheirs = marker();
    await runWithTenant(ORG_A_ID, () => reply(ORG_A_ID, CRM_THREAD_B_ID, asOwn));
    // Naming B while working as A: the statement's own org filter passes, the policy does not.
    await runWithTenant(ORG_A_ID, () => reply(ORG_B_ID, CRM_THREAD_B_ID, asTheirs));

    expect(await written(ORG_B_ID, asOwn)).toEqual([]);
    expect(await written(ORG_B_ID, asTheirs)).toEqual([]);
    expect(await written(ORG_A_ID, asOwn)).toEqual([]);
    expect(await written(ORG_A_ID, asTheirs)).toEqual([]);
  });
});
