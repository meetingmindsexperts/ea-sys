/**
 * Budget & Procurement module (born tenancy-compliant, Sep 14 2026): the nine
 * policies in prisma/rls/procurement.sql, the SAME file the platform bootstrap
 * applies, enforced end to end through the ALS store, the SET LOCAL extension
 * and pgbouncer, as the non-owner app_user. The HR suite is the template.
 *
 * Domain-specific proofs:
 *   - `BudgetCategory.code` is unique per ORG, not globally, so BOTH orgs hold
 *     a category on the SAME code and the unscoped read must resolve to the
 *     caller's own row (identity, not count).
 *   - `EventBudget.eventCode` is likewise a per-org label: both orgs hold a
 *     budget on the same code.
 *   - BudgetLine and ApprovalStep are children read through their own flat
 *     organizationId, so a cross-tenant read addressed by the parent id misses.
 *   - Writes both ways: WITH CHECK refuses a foreign org on a create, and
 *     refuses re-homing an owned row.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { ORG_A_ID, ORG_B_ID } from "./constants";

const CAT_A = "tenancy-bp-cat-a";
const CAT_B = "tenancy-bp-cat-b";
const TPL_A = "tenancy-bp-tpl-a";
const TPL_B = "tenancy-bp-tpl-b";
const TLINE_A = "tenancy-bp-tline-a";
const TLINE_B = "tenancy-bp-tline-b";
const BUD_A = "tenancy-bp-bud-a";
const BUD_B = "tenancy-bp-bud-b";
const LINE_A = "tenancy-bp-line-a";
const LINE_B = "tenancy-bp-line-b";
/** Revenue (Sep 17 2026): both orgs plan revenue on the same income-account code. */
const SHARED_INCOME_CODE = "430005";
const RCAT_A = "tenancy-bp-rcat-a";
const RCAT_B = "tenancy-bp-rcat-b";
const RLINE_A = "tenancy-bp-rline-a";
const RLINE_B = "tenancy-bp-rline-b";
const WF_A = "tenancy-bp-wf-a";
const WF_B = "tenancy-bp-wf-b";
const REQ_A = "tenancy-bp-req-a";
const REQ_B = "tenancy-bp-req-b";
const STEP_A = "tenancy-bp-step-a";
const STEP_B = "tenancy-bp-step-b";
const SUM_A = "tenancy-bp-sum-a";
const SUM_B = "tenancy-bp-sum-b";

/** Both orgs use this category code and this event code. Scoping keeps them apart. */
const SHARED_CATEGORY_CODE = "VENUE";
/** Both orgs hold this SKU too: `BudgetProduct.sku` is unique per ORG. */
const SHARED_SKU = "510301";
const PROD_A = "tenancy-bp-prod-a";
const PROD_B = "tenancy-bp-prod-b";
/** Phase 2 (purchasing): both orgs hold a supplier on the SAME code and a request and an order on the SAME numbers. */
const SHARED_SUPPLIER_CODE = "ACME";
const SHARED_REQUEST_NO = "PR-2026-0001";
const SHARED_COMMITMENT_NO = "PO-2026-0001";
const SUP_A = "tenancy-bp-sup-a";
const SUP_B = "tenancy-bp-sup-b";
const SREQ_A = "tenancy-bp-sreq-a";
const SREQ_B = "tenancy-bp-sreq-b";
const COM_A = "tenancy-bp-com-a";
const COM_B = "tenancy-bp-com-b";
const CLINE_A = "tenancy-bp-cline-a";
const CLINE_B = "tenancy-bp-cline-b";
const SHARED_EVENT_CODE = "TEN2026";
const NOW = new Date("2026-09-14T00:00:00.000Z");

let owner: PrismaClient;

beforeAll(async () => {
  process.env.RLS_SET_LOCAL = "1";
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL (owner, raw :5432) is required to seed fixtures");
  owner = new PrismaClient({ datasources: { db: { url } } });
  await cleanup();

  await owner.budgetCategory.createMany({
    data: [
      { id: CAT_A, organizationId: ORG_A_ID, code: SHARED_CATEGORY_CODE, name: "Venue (A)" },
      { id: CAT_B, organizationId: ORG_B_ID, code: SHARED_CATEGORY_CODE, name: "Venue (B)" },
    ],
  });
  await owner.budgetProduct.createMany({
    data: [
      { id: PROD_A, organizationId: ORG_A_ID, sku: SHARED_SKU, name: "AV rental (A)", categoryId: CAT_A },
      { id: PROD_B, organizationId: ORG_B_ID, sku: SHARED_SKU, name: "AV rental (B)", categoryId: CAT_B },
    ],
  });
  await owner.budgetTemplate.createMany({
    data: [
      { id: TPL_A, organizationId: ORG_A_ID, name: "Conference", eventType: "CONFERENCE" },
      { id: TPL_B, organizationId: ORG_B_ID, name: "Conference", eventType: "CONFERENCE" },
    ],
  });
  await owner.budgetTemplateLine.createMany({
    data: [
      { id: TLINE_A, organizationId: ORG_A_ID, templateId: TPL_A, categoryId: CAT_A, description: "Hall hire" },
      { id: TLINE_B, organizationId: ORG_B_ID, templateId: TPL_B, categoryId: CAT_B, description: "Hall hire" },
    ],
  });
  await owner.eventBudget.createMany({
    data: [
      { id: BUD_A, organizationId: ORG_A_ID, eventId: null, eventCode: SHARED_EVENT_CODE, versionNo: 1, reportingCurrency: "AED", ownerUserId: "owner-a", createdByUserId: "owner-a" },
      { id: BUD_B, organizationId: ORG_B_ID, eventId: null, eventCode: SHARED_EVENT_CODE, versionNo: 1, reportingCurrency: "AED", ownerUserId: "owner-b", createdByUserId: "owner-b" },
    ],
  });
  await owner.budgetLine.createMany({
    data: [
      { id: LINE_A, organizationId: ORG_A_ID, budgetId: BUD_A, lineKey: "line-a", categoryId: CAT_A, description: "Hall hire", transactionCurrency: "AED", planned: 1000 },
      { id: LINE_B, organizationId: ORG_B_ID, budgetId: BUD_B, lineKey: "line-b", categoryId: CAT_B, description: "Hall hire", transactionCurrency: "AED", planned: 2000 },
    ],
  });
  await owner.budgetCategory.createMany({
    data: [
      { id: RCAT_A, organizationId: ORG_A_ID, code: SHARED_INCOME_CODE, name: "Delegate Sales (A)", type: "REVENUE" },
      { id: RCAT_B, organizationId: ORG_B_ID, code: SHARED_INCOME_CODE, name: "Delegate Sales (B)", type: "REVENUE" },
    ],
  });
  await owner.budgetRevenueLine.createMany({
    data: [
      { id: RLINE_A, organizationId: ORG_A_ID, budgetId: BUD_A, lineKey: "rline-a", categoryId: RCAT_A, description: "Physicians", transactionCurrency: "AED", planned: 5000 },
      { id: RLINE_B, organizationId: ORG_B_ID, budgetId: BUD_B, lineKey: "rline-b", categoryId: RCAT_B, description: "Physicians", transactionCurrency: "AED", planned: 7000 },
    ],
  });
  await owner.approvalWorkflowDefinition.createMany({
    data: [
      { id: WF_A, organizationId: ORG_A_ID, name: "Budgets", subjectType: "BUDGET", bands: [] },
      { id: WF_B, organizationId: ORG_B_ID, name: "Budgets", subjectType: "BUDGET", bands: [] },
    ],
  });
  await owner.approvalRequest.createMany({
    data: [
      { id: REQ_A, organizationId: ORG_A_ID, subjectType: "BUDGET", subjectId: BUD_A, amountAed: 1000, requesterUserId: "owner-a" },
      { id: REQ_B, organizationId: ORG_B_ID, subjectType: "BUDGET", subjectId: BUD_B, amountAed: 2000, requesterUserId: "owner-b" },
    ],
  });
  await owner.approvalStep.createMany({
    data: [
      { id: STEP_A, organizationId: ORG_A_ID, requestId: REQ_A, sequence: 1, assigneeUserId: "approver-a", dueAt: NOW },
      { id: STEP_B, organizationId: ORG_B_ID, requestId: REQ_B, sequence: 1, assigneeUserId: "approver-b", dueAt: NOW },
    ],
  });
  await owner.eventFinancialSummary.createMany({
    data: [
      { id: SUM_A, organizationId: ORG_A_ID, sourceSystem: "EA_SYS", eventCode: SHARED_EVENT_CODE, name: "Ten 2026 (A)", year: 2026, currency: "AED", categoryTotals: {}, asOf: NOW },
      { id: SUM_B, organizationId: ORG_B_ID, sourceSystem: "EA_SYS", eventCode: SHARED_EVENT_CODE, name: "Ten 2026 (B)", year: 2026, currency: "AED", categoryTotals: {}, asOf: NOW },
    ],
  });
  await owner.supplier.createMany({
    data: [
      { id: SUP_A, organizationId: ORG_A_ID, code: SHARED_SUPPLIER_CODE, legalName: "Acme (A)", displayName: "Acme", currency: "AED", approvalStatus: "APPROVED", taxRegistrationNo: "TRN-A" },
      { id: SUP_B, organizationId: ORG_B_ID, code: SHARED_SUPPLIER_CODE, legalName: "Acme (B)", displayName: "Acme", currency: "AED", approvalStatus: "APPROVED", taxRegistrationNo: "TRN-B" },
    ],
  });
  await owner.spendRequest.createMany({
    data: [
      { id: SREQ_A, organizationId: ORG_A_ID, requestNo: SHARED_REQUEST_NO, budgetId: BUD_A, lineKey: "line-a", eventCode: SHARED_EVENT_CODE, requesterUserId: "owner-a", supplierId: SUP_A, title: "Hall deposit", currency: "AED", amount: 500 },
      { id: SREQ_B, organizationId: ORG_B_ID, requestNo: SHARED_REQUEST_NO, budgetId: BUD_B, lineKey: "line-b", eventCode: SHARED_EVENT_CODE, requesterUserId: "owner-b", supplierId: SUP_B, title: "Hall deposit", currency: "AED", amount: 900 },
    ],
  });
  await owner.commitment.createMany({
    data: [
      { id: COM_A, organizationId: ORG_A_ID, commitmentNo: SHARED_COMMITMENT_NO, spendRequestId: SREQ_A, budgetId: BUD_A, lineKey: "line-a", supplierId: SUP_A, eventCode: SHARED_EVENT_CODE, currency: "AED", amount: 500 },
      { id: COM_B, organizationId: ORG_B_ID, commitmentNo: SHARED_COMMITMENT_NO, spendRequestId: SREQ_B, budgetId: BUD_B, lineKey: "line-b", supplierId: SUP_B, eventCode: SHARED_EVENT_CODE, currency: "AED", amount: 900 },
    ],
  });
  await owner.commitmentLine.createMany({
    data: [
      { id: CLINE_A, organizationId: ORG_A_ID, commitmentId: COM_A, lineKey: "line-a", description: "Hall deposit", amount: 500 },
      { id: CLINE_B, organizationId: ORG_B_ID, commitmentId: COM_B, lineKey: "line-b", description: "Hall deposit", amount: 900 },
    ],
  });
  await owner.spendRequestCounter.createMany({ data: [{ organizationId: ORG_A_ID, year: 2026, lastSerial: 1 }, { organizationId: ORG_B_ID, year: 2026, lastSerial: 1 }], skipDuplicates: true });
  await owner.commitmentCounter.createMany({ data: [{ organizationId: ORG_A_ID, year: 2026, lastSerial: 1 }, { organizationId: ORG_B_ID, year: 2026, lastSerial: 1 }], skipDuplicates: true });
});

async function cleanup() {
  await owner?.commitmentLine.deleteMany({ where: { id: { in: [CLINE_A, CLINE_B] } } });
  await owner?.commitment.deleteMany({ where: { id: { in: [COM_A, COM_B] } } });
  await owner?.spendRequest.deleteMany({ where: { id: { in: [SREQ_A, SREQ_B] } } });
  await owner?.supplier.deleteMany({ where: { id: { in: [SUP_A, SUP_B] } } });
  await owner?.spendRequestCounter.deleteMany({ where: { organizationId: { in: [ORG_A_ID, ORG_B_ID] }, year: 2026 } });
  await owner?.commitmentCounter.deleteMany({ where: { organizationId: { in: [ORG_A_ID, ORG_B_ID] }, year: 2026 } });
  await owner?.approvalStep.deleteMany({ where: { id: { in: [STEP_A, STEP_B] } } });
  await owner?.approvalRequest.deleteMany({ where: { id: { in: [REQ_A, REQ_B] } } });
  await owner?.approvalWorkflowDefinition.deleteMany({ where: { id: { in: [WF_A, WF_B] } } });
  await owner?.eventFinancialSummary.deleteMany({ where: { id: { in: [SUM_A, SUM_B] } } });
  await owner?.budgetLine.deleteMany({ where: { id: { in: [LINE_A, LINE_B] } } });
  await owner?.budgetRevenueLine.deleteMany({ where: { id: { in: [RLINE_A, RLINE_B] } } });
  await owner?.eventBudget.deleteMany({ where: { id: { in: [BUD_A, BUD_B] } } });
  await owner?.budgetTemplateLine.deleteMany({ where: { id: { in: [TLINE_A, TLINE_B] } } });
  await owner?.budgetTemplate.deleteMany({ where: { id: { in: [TPL_A, TPL_B] } } });
  await owner?.budgetProduct.deleteMany({ where: { id: { in: [PROD_A, PROD_B] } } });
  await owner?.budgetCategory.deleteMany({ where: { id: { in: [CAT_A, CAT_B, RCAT_A, RCAT_B] } } });
}

afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await cleanup();
  await owner?.$disconnect();
  await db.$disconnect();
});

describe("Budget & Procurement RLS via the SET LOCAL extension", () => {
  it("lane-scoped: the SHARED category code resolves to each lane's own row", async () => {
    const inA = await runWithTenant(ORG_A_ID, () => db.budgetCategory.findFirst({ where: { code: SHARED_CATEGORY_CODE } }));
    const inB = await runWithTenant(ORG_B_ID, () => db.budgetCategory.findFirst({ where: { code: SHARED_CATEGORY_CODE } }));
    expect(inA?.id).toBe(CAT_A);
    expect(inB?.id).toBe(CAT_B);
    const prodA = await runWithTenant(ORG_A_ID, () => db.budgetProduct.findFirst({ where: { sku: SHARED_SKU } }));
    const prodB = await runWithTenant(ORG_B_ID, () => db.budgetProduct.findFirst({ where: { sku: SHARED_SKU } }));
    expect(prodA?.id).toBe(PROD_A);
    expect(prodB?.id).toBe(PROD_B);
  });

  it("lane-scoped (purchasing): the SHARED supplier code, request number and order number resolve per lane", async () => {
    expect((await runWithTenant(ORG_A_ID, () => db.supplier.findFirst({ where: { code: SHARED_SUPPLIER_CODE } })))?.id).toBe(SUP_A);
    expect((await runWithTenant(ORG_B_ID, () => db.supplier.findFirst({ where: { code: SHARED_SUPPLIER_CODE } })))?.id).toBe(SUP_B);
    expect((await runWithTenant(ORG_A_ID, () => db.spendRequest.findFirst({ where: { requestNo: SHARED_REQUEST_NO } })))?.id).toBe(SREQ_A);
    expect((await runWithTenant(ORG_B_ID, () => db.commitment.findFirst({ where: { commitmentNo: SHARED_COMMITMENT_NO } })))?.id).toBe(COM_B);
    // A child addressed by the parent id misses across the fence, and a counter row is invisible from the other lane.
    expect(await runWithTenant(ORG_A_ID, () => db.commitmentLine.findMany({ where: { commitmentId: COM_B } }))).toHaveLength(0);
    expect(await runWithTenant(ORG_A_ID, () => db.spendRequestCounter.findMany({ where: { organizationId: ORG_B_ID } }))).toHaveLength(0);
  });

  it("lane-scoped: the SHARED event code resolves to each lane's own budget and summary", async () => {
    const budA = await runWithTenant(ORG_A_ID, () => db.eventBudget.findFirst({ where: { eventCode: SHARED_EVENT_CODE } }));
    const budB = await runWithTenant(ORG_B_ID, () => db.eventBudget.findFirst({ where: { eventCode: SHARED_EVENT_CODE } }));
    expect(budA?.id).toBe(BUD_A);
    expect(budB?.id).toBe(BUD_B);
    const sumA = await runWithTenant(ORG_A_ID, () => db.eventFinancialSummary.findFirst({ where: { eventCode: SHARED_EVENT_CODE } }));
    expect(sumA?.id).toBe(SUM_A);
  });

  it("revenue: the SHARED income-account code resolves per lane, and B's revenue lines miss by budget id", async () => {
    expect((await runWithTenant(ORG_A_ID, () => db.budgetCategory.findFirst({ where: { code: SHARED_INCOME_CODE, type: "REVENUE" } })))?.id).toBe(RCAT_A);
    expect((await runWithTenant(ORG_B_ID, () => db.budgetCategory.findFirst({ where: { code: SHARED_INCOME_CODE, type: "REVENUE" } })))?.id).toBe(RCAT_B);
    expect(await runWithTenant(ORG_A_ID, () => db.budgetRevenueLine.findMany({ where: { budgetId: BUD_B } }))).toHaveLength(0);
    const own = await runWithTenant(ORG_A_ID, () => db.budgetRevenueLine.findMany({ where: { lineKey: { in: ["rline-a", "rline-b"] } } }));
    expect(own.map((l) => l.id)).toEqual([RLINE_A]);
    expect(await db.budgetRevenueLine.findMany({ where: { id: { in: [RLINE_A, RLINE_B] } } })).toHaveLength(0);
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.budgetRevenueLine.create({ data: { organizationId: ORG_B_ID, budgetId: BUD_B, lineKey: "smuggled", categoryId: RCAT_B, description: "x", transactionCurrency: "AED" } }),
      ),
    ).rejects.toThrow();
  });

  it("cross-tenant miss: B's budget is invisible from A's lane, even by id", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.eventBudget.findUnique({ where: { id: BUD_B } }))).toBeNull();
  });

  it("cross-tenant miss: children addressed by the parent id miss (line by budgetId, step by requestId)", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.budgetLine.findMany({ where: { budgetId: BUD_B } }))).toHaveLength(0);
    expect(await runWithTenant(ORG_A_ID, () => db.approvalStep.findMany({ where: { requestId: REQ_B } }))).toHaveLength(0);
    expect(await runWithTenant(ORG_A_ID, () => db.budgetTemplateLine.findMany({ where: { templateId: TPL_B } }))).toHaveLength(0);
  });

  it("fails closed across every module table with no tenant store", async () => {
    expect(await db.budgetCategory.findMany({ where: { code: SHARED_CATEGORY_CODE } })).toHaveLength(0);
    expect(await db.budgetProduct.findMany({ where: { sku: SHARED_SKU } })).toHaveLength(0);
    expect(await db.supplier.findMany({ where: { code: SHARED_SUPPLIER_CODE } })).toHaveLength(0);
    expect(await db.spendRequest.findMany({ where: { requestNo: SHARED_REQUEST_NO } })).toHaveLength(0);
    expect(await db.commitment.findMany({ where: { commitmentNo: SHARED_COMMITMENT_NO } })).toHaveLength(0);
    expect(await db.commitmentLine.findMany({ where: { id: { in: [CLINE_A, CLINE_B] } } })).toHaveLength(0);
    expect(await db.spendRequestCounter.findMany({ where: { year: 2026 } })).toHaveLength(0);
    expect(await db.commitmentCounter.findMany({ where: { year: 2026 } })).toHaveLength(0);
    expect(await db.budgetTemplate.findMany({ where: { name: "Conference" } })).toHaveLength(0);
    expect(await db.budgetTemplateLine.findMany({ where: { id: { in: [TLINE_A, TLINE_B] } } })).toHaveLength(0);
    expect(await db.eventBudget.findMany({ where: { eventCode: SHARED_EVENT_CODE } })).toHaveLength(0);
    expect(await db.budgetLine.findMany({ where: { id: { in: [LINE_A, LINE_B] } } })).toHaveLength(0);
    expect(await db.approvalWorkflowDefinition.findMany({ where: { id: { in: [WF_A, WF_B] } } })).toHaveLength(0);
    expect(await db.approvalRequest.findMany({ where: { id: { in: [REQ_A, REQ_B] } } })).toHaveLength(0);
    expect(await db.approvalStep.findMany({ where: { id: { in: [STEP_A, STEP_B] } } })).toHaveLength(0);
    expect(await db.eventFinancialSummary.findMany({ where: { eventCode: SHARED_EVENT_CODE } })).toHaveLength(0);
  });

  it("WITH CHECK refuses smuggling a foreign org onto a create", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.budgetLine.create({
          data: { organizationId: ORG_B_ID, budgetId: BUD_B, lineKey: "smuggled", categoryId: CAT_B, description: "x", transactionCurrency: "AED" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("WITH CHECK refuses re-homing an owned budget to another org", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.eventBudget.update({ where: { id: BUD_A }, data: { organizationId: ORG_B_ID } })),
    ).rejects.toThrow();
  });

  it("cross-tenant DELETE affects nothing", async () => {
    const res = await runWithTenant(ORG_A_ID, () => db.eventBudget.deleteMany({ where: { id: BUD_B } }));
    expect(res.count).toBe(0);
    expect(await owner.eventBudget.findUnique({ where: { id: BUD_B } })).not.toBeNull();
  });

  it("lane-scoped: an approver sees only their own lane's step", async () => {
    const a = await runWithTenant(ORG_A_ID, () => db.approvalStep.findFirst({ where: { sequence: 1 } }));
    const b = await runWithTenant(ORG_B_ID, () => db.approvalStep.findFirst({ where: { sequence: 1 } }));
    expect(a?.id).toBe(STEP_A);
    expect(b?.id).toBe(STEP_B);
  });

  /**
   * Defence #1 in isolation. The OWNER role bypasses the non-FORCE policy, so
   * this exercises only the compound where every module write carries
   * (`updateMany({ where: { id, organizationId } })`): even with RLS out of
   * the picture, the write itself cannot reach another tenant's row.
   */
  it("defence #1 in isolation: an org-bound budget update misses a foreign row even as owner", async () => {
    const res = await owner.eventBudget.updateMany({
      where: { id: BUD_B, organizationId: ORG_A_ID },
      data: { notes: "Hijacked" },
    });
    expect(res.count).toBe(0);
    const row = await owner.eventBudget.findUnique({ where: { id: BUD_B }, select: { notes: true } });
    expect(row?.notes).toBeNull();
  });
});
