/**
 * Adversarial test P1-4 (Oct 28, 2026), on a REAL Postgres: an admin of
 * organisation B sends organisation A's ids to every procurement write. Each
 * must be refused, and every procurement row A holds must come out exactly as
 * it went in (updatedAt included, so a write of the same values still shows).
 *
 * The routes pass the session's organisation and nothing from the request
 * (pinned by __tests__/procurement/route-org-source.test.ts), so the service
 * boundary is where a foreign id meets an organisation; this file covers every
 * exported procurement write that takes an id.
 *
 * Run: INTEGRATION_TEST_DATABASE_URL=postgres://…/<scratch db> npm run test:integration-db
 */
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import * as budgets from "@/procurement/services/budget-service";
import * as revenue from "@/procurement/services/budget-revenue-service";
import * as templates from "@/procurement/services/budget-template-service";
import * as categories from "@/procurement/services/budget-category-service";
import * as products from "@/procurement/services/budget-product-service";
import * as suppliers from "@/procurement/services/supplier-service";
import * as requests from "@/procurement/services/spend-request-service";
import * as orders from "@/procurement/services/commitment-service";
import { resetCrm } from "./helper";

interface A {
  orgId: string; userId: string; eventId: string; budgetId: string; lineId: string; lineKey: string; revenueLineId: string;
  templateId: string; templateLineId: string; categoryId: string; productId: string; supplierId: string;
  requestId: string; quoteId: string; commitmentId: string; approvalId: string;
}
let a: A;
let orgB: string;
let userB: string;

/** Everything A holds in the procurement tables, in a stable order. */
async function snapshotA() {
  const org = { organizationId: a.orgId };
  const order = { id: "asc" as const };
  const [b, l, r, t, tl, c, p, s, sr, q, co, ar, st, audit] = await Promise.all([
    db.eventBudget.findMany({ where: org, orderBy: order }),
    db.budgetLine.findMany({ where: org, orderBy: order }),
    db.budgetRevenueLine.findMany({ where: org, orderBy: order }),
    db.budgetTemplate.findMany({ where: org, orderBy: order }),
    db.budgetTemplateLine.findMany({ where: org, orderBy: order }),
    db.budgetCategory.findMany({ where: org, orderBy: order }),
    db.budgetProduct.findMany({ where: org, orderBy: order }),
    db.supplier.findMany({ where: org, orderBy: order }),
    db.spendRequest.findMany({ where: org, orderBy: order }),
    db.spendRequestQuote.findMany({ where: org, orderBy: order }),
    db.commitment.findMany({ where: org, orderBy: order }),
    db.approvalRequest.findMany({ where: org, orderBy: order }),
    db.approvalStep.findMany({ where: org, orderBy: order }),
    db.auditLog.count({ where: org }),
  ]);
  return JSON.stringify({ b, l, r, t, tl, c, p, s, sr, q, co, ar, st, audit });
}

beforeAll(async () => {
  const seed = await resetCrm();
  const orgId = seed.orgId;
  const userId = seed.userId;
  const event = await db.event.create({ data: { organizationId: orgId, name: "A congress", code: "ACON26", slug: `a-con-${Date.now()}`, startDate: new Date("2026-12-01"), endDate: new Date("2026-12-02") }, select: { id: true } });
  const created = await runWithTenant(orgId, () => budgets.createBudget({ organizationId: orgId, actorUserId: userId, source: "ui", eventId: event.id, reportingCurrency: "AED", contingencyPercent: 5 }));
  if (!created.ok) throw new Error(`seed: ${created.code}`);
  const categoryId = (await db.budgetCategory.findFirstOrThrow({ where: { organizationId: orgId, code: "510300" }, select: { id: true } })).id;
  const line = await db.budgetLine.create({ data: { organizationId: orgId, budgetId: created.budget.id, lineKey: "k-av", categoryId, description: "LED wall", transactionCurrency: "AED", qty: "1", unitCost: "1000", planned: "1000" }, select: { id: true, lineKey: true } });
  const income = await revenue.ensureRevenueCategories(orgId);
  const revenueLine = await db.budgetRevenueLine.create({ data: { organizationId: orgId, budgetId: created.budget.id, lineKey: "r-1", categoryId: income[0].id, description: "Delegates", transactionCurrency: "AED", qty: "1", unitAmount: "500", planned: "500" }, select: { id: true } });
  const template = await db.budgetTemplate.create({ data: { organizationId: orgId, name: "A template", eventType: "CONFERENCE" }, select: { id: true } });
  const templateLine = await db.budgetTemplateLine.create({ data: { organizationId: orgId, templateId: template.id, categoryId, description: "AV" }, select: { id: true } });
  const product = await db.budgetProduct.create({ data: { organizationId: orgId, sku: "510301", name: "AV rental", categoryId }, select: { id: true } });
  const supplier = await db.supplier.create({ data: { organizationId: orgId, code: "GAV", legalName: "Gulf AV LLC", displayName: "Gulf AV", currency: "AED" }, select: { id: true } });
  const request = await db.spendRequest.create({ data: { organizationId: orgId, requestNo: "PR-A-0001", eventCode: "ACON26", requesterUserId: userId, title: "LED wall", currency: "AED", budgetId: created.budget.id, lineKey: "k-av", amount: "900" }, select: { id: true } });
  const quote = await db.spendRequestQuote.create({ data: { organizationId: orgId, spendRequestId: request.id, vendorName: "Gulf AV", currency: "AED", amount: "900" }, select: { id: true } });
  const commitment = await db.commitment.create({ data: { organizationId: orgId, commitmentNo: "PO-A-0001", budgetId: created.budget.id, lineKey: "k-av", supplierId: supplier.id, eventCode: "ACON26", currency: "AED", amount: "900", fxRateToReporting: "1", status: "APPROVED" }, select: { id: true } });
  const approval = await db.approvalRequest.create({ data: { organizationId: orgId, subjectType: "SPEND_REQUEST", subjectId: request.id, amountAed: "900", requesterUserId: userId, status: "PENDING" }, select: { id: true } });
  await db.approvalStep.create({ data: { organizationId: orgId, requestId: approval.id, sequence: 1, assigneeUserId: userId, dueAt: new Date("2026-12-01") } });
  a = {
    orgId, userId, eventId: event.id, budgetId: created.budget.id, lineId: line.id, lineKey: line.lineKey, revenueLineId: revenueLine.id,
    templateId: template.id, templateLineId: templateLine.id, categoryId, productId: product.id, supplierId: supplier.id,
    requestId: request.id, quoteId: quote.id, commitmentId: commitment.id, approvalId: approval.id,
  };

  const b = await db.organization.create({ data: { name: "B org", slug: `b-org-${Date.now()}`, companyName: "B Co" }, select: { id: true } });
  orgB = b.id;
  userB = (await db.user.create({ data: { organizationId: orgB, email: `admin-b-${Date.now()}@test.local`, passwordHash: "x", firstName: "Bo", lastName: "Admin", role: "SUPER_ADMIN" }, select: { id: true } })).id;
}, 120_000);

/** Every procurement write that takes an id, called as B with A's ids. */
function attacks() {
  const ui = "ui" as const;
  const base = { organizationId: orgB, actorUserId: userB, source: ui };
  const decider = { id: userB, role: "SUPER_ADMIN", organizationId: orgB, procurementApproveUnlimited: true, procurementApproveCeilingAed: null, procurementRequest: true, procurementSettle: true };
  const actor = { id: userB, isAdmin: true };
  const orderActor = { id: userB, isAdmin: true, canRequest: true, canSettle: true, canApprove: true };
  const call = <T,>(f: () => Promise<T>) => f;
  return {
    createBudget: call(() => budgets.createBudget({ ...base, eventId: a.eventId, reportingCurrency: "AED" })),
    createBudgetCopy: call(() => budgets.createBudget({ ...base, eventId: a.eventId, reportingCurrency: "AED", fromBudgetId: a.budgetId, copyRevenue: true })),
    updateBudgetHeader: call(() => budgets.updateBudgetHeader({ ...base, budgetId: a.budgetId, expectedVersion: 0, contingencyPercent: 50 })),
    upsertBudgetLine: call(() => budgets.upsertBudgetLine({ ...base, budgetId: a.budgetId, lineId: a.lineId, qty: 99 })),
    addBudgetLine: call(() => budgets.upsertBudgetLine({ ...base, budgetId: a.budgetId, categoryId: a.categoryId, description: "x", qty: 1, unitCost: 1 })),
    deleteBudgetLine: call(() => budgets.deleteBudgetLine({ ...base, budgetId: a.budgetId, lineId: a.lineId })),
    submitBudget: call(() => budgets.submitBudget({ ...base, budgetId: a.budgetId })),
    decideBudget: call(() => budgets.decideBudget({ organizationId: orgB, decider: decider as never, source: ui, budgetId: a.budgetId, decision: "APPROVED" })),
    newBudgetVersion: call(() => budgets.newBudgetVersion({ ...base, budgetId: a.budgetId })),
    reallocateBudget: call(() => budgets.reallocateBudget({ ...base, actor: decider as never, budgetId: a.budgetId, fromLineKey: a.lineKey, toLineKey: a.lineKey, amount: 1, reason: "x" })),
    decideReallocation: call(() => budgets.decideReallocation({ organizationId: orgB, decider: decider as never, source: ui, requestId: a.approvalId, decision: "APPROVED" })),
    freezeBudget: call(() => budgets.freezeBudget({ ...base, budgetId: a.budgetId })),
    unfreezeBudget: call(() => budgets.unfreezeBudget({ ...base, budgetId: a.budgetId, reason: "x" })),
    closeBudget: call(() => budgets.closeBudget({ ...base, budgetId: a.budgetId })),
    signOffBudget: call(() => budgets.signOffBudget({ ...base, budgetId: a.budgetId })),
    reopenBudget: call(() => budgets.reopenBudget({ ...base, budgetId: a.budgetId, reason: "x" })),
    discardDraftBudget: call(() => budgets.discardDraftBudget({ ...base, budgetId: a.budgetId })),
    upsertRevenueLine: call(() => revenue.upsertRevenueLine({ ...base, budgetId: a.budgetId, lineId: a.revenueLineId, qty: 99 })),
    deleteRevenueLine: call(() => revenue.deleteRevenueLine({ ...base, budgetId: a.budgetId, lineId: a.revenueLineId })),
    updateBudgetTemplate: call(() => templates.updateBudgetTemplate({ ...base, templateId: a.templateId, name: "hijacked" })),
    upsertTemplateLine: call(() => templates.upsertTemplateLine({ ...base, templateId: a.templateId, lineId: a.templateLineId, description: "hijacked" })),
    deleteTemplateLine: call(() => templates.deleteTemplateLine({ ...base, templateId: a.templateId, lineId: a.templateLineId })),
    archiveBudgetCategory: call(() => categories.archiveBudgetCategory({ organizationId: orgB, actorUserId: userB, categoryId: a.categoryId, active: false })),
    updateBudgetProduct: call(() => products.updateBudgetProduct({ organizationId: orgB, actorUserId: userB, productId: a.productId, name: "hijacked" } as never)),
    updateSupplier: call(() => suppliers.updateSupplier({ organizationId: orgB, actor: decider, actorUserId: userB, source: ui, supplierId: a.supplierId, displayName: "hijacked", expectedVersion: 0 } as never)),
    decideSupplier: call(() => suppliers.decideSupplier({ organizationId: orgB, actor: decider, actorUserId: userB, source: ui, supplierId: a.supplierId, decision: "APPROVED" } as never)),
    createSpendRequest: call(() => requests.createSpendRequest({ organizationId: orgB, actor, source: ui, budgetId: a.budgetId, lineKey: a.lineKey, title: "x", amount: 1, currency: "AED" } as never)),
    updateSpendRequest: call(() => requests.updateSpendRequest({ organizationId: orgB, actor, source: ui, requestId: a.requestId, expectedVersion: 0, title: "hijacked" } as never)),
    submitSpendRequest: call(() => requests.submitSpendRequest({ organizationId: orgB, actor, source: ui, requestId: a.requestId, expectedVersion: 0 })),
    decideSpendRequest: call(() => requests.decideSpendRequest({ organizationId: orgB, decider: decider as never, source: ui, approvalRequestId: a.approvalId, decision: "APPROVED" })),
    amendSpendRequest: call(() => requests.amendSpendRequest({ organizationId: orgB, actor, source: ui, requestId: a.requestId, expectedVersion: 0, amount: 1, reason: "x" } as never)),
    transitionSpendRequest: call(() => requests.transitionSpendRequest({ organizationId: orgB, actor, source: ui, requestId: a.requestId, expectedVersion: 0, action: "withdraw" })),
    addQuote: call(() => requests.addQuote({ organizationId: orgB, actor, source: ui, requestId: a.requestId, vendorName: "x", amount: 1, currency: "AED" } as never)),
    removeQuote: call(() => requests.removeQuote({ organizationId: orgB, actor, source: ui, requestId: a.requestId, quoteId: a.quoteId })),
    setQuoteFile: call(() => requests.setQuoteFile({ organizationId: orgB, actor, source: ui, requestId: a.requestId, quoteId: a.quoteId, fileUrl: null, fileName: null, fileMimeType: null, fileSize: null } as never)),
    raiseOrder: call(() => orders.raiseOrder({ organizationId: orgB, actor: orderActor, source: ui, requestId: a.requestId })),
    sendOrderToSupplier: call(() => orders.sendOrderToSupplier({ organizationId: orgB, actor: orderActor, source: ui, commitmentId: a.commitmentId })),
    receiveOrder: call(() => orders.receiveOrder({ organizationId: orgB, actor: orderActor, source: ui, commitmentId: a.commitmentId, extent: "FULL", expectedVersion: 0 } as never)),
    confirmReceipt: call(() => orders.confirmReceipt({ organizationId: orgB, actor: orderActor, source: ui, commitmentId: a.commitmentId, expectedVersion: 0 })),
    undoReceipt: call(() => orders.undoReceipt({ organizationId: orgB, actor: orderActor, source: ui, commitmentId: a.commitmentId, expectedVersion: 0 })),
    cancelOrder: call(() => orders.cancelOrder({ organizationId: orgB, actor: orderActor, source: ui, commitmentId: a.commitmentId, reason: "x", expectedVersion: 0 } as never)),
    convertRequestsAwaitingSupplier: call(() => orders.convertRequestsAwaitingSupplier({ organizationId: orgB, supplierId: a.supplierId, actorUserId: userB, source: ui })),
  };
}

/** A refusal is a result that is not ok, or a thrown error; either way nothing of A's may change. */
async function outcome(f: () => Promise<unknown>): Promise<{ refused: boolean; detail: string }> {
  try {
    const r = (await runWithTenant(orgB, f)) as { ok?: boolean; code?: string; issued?: unknown[] } | null;
    if (r && typeof r === "object" && "ok" in r) return { refused: r.ok === false, detail: String(r.code ?? "ok") };
    // convertRequestsAwaitingSupplier answers with the orders it issued: none of A's is the refusal.
    if (r && typeof r === "object" && "issued" in r) return { refused: Array.isArray(r.issued) && r.issued.length === 0, detail: JSON.stringify(r) };
    return { refused: false, detail: JSON.stringify(r) };
  } catch (err) {
    return { refused: true, detail: `threw: ${(err as Error).message.slice(0, 80)}` };
  }
}

describe("procurement writes refuse another organisation's ids (P1-4)", () => {
  it.each(Object.keys(attacks()))("%s, called as organisation B with organisation A's ids, is refused and changes nothing of A's", async (name) => {
    const before = await snapshotA();
    const { refused, detail } = await outcome(attacks()[name as keyof ReturnType<typeof attacks>]);
    if (process.env.SHOW_REFUSALS) console.log(`REFUSAL ${name}: ${detail}`);
    expect(refused, `${name} answered ${detail}`).toBe(true);
    expect(await snapshotA(), `${name} changed organisation A's procurement rows`).toBe(before);
  });

  it("control: the same line edit made by organisation A itself succeeds, so the refusals above are about the organisation", async () => {
    const r = await runWithTenant(a.orgId, () => budgets.upsertBudgetLine({ organizationId: a.orgId, actorUserId: a.userId, source: "ui", budgetId: a.budgetId, lineId: a.lineId, qty: 2 }));
    expect(r.ok).toBe(true);
  });

  it("covers every exported write that takes an id", () => {
    // A new write function must join the list above or be named here as not taking an id.
    const noId = new Set([
      "claimBudgetForWrite", "createBudgetCategory", "createBudgetProduct", "importBudgetProducts", "createBudgetTemplate",
      "realignBudgetCategories", "proposeSupplier", "importSuppliers", "saveApprovalChain", "issueOrderInTx", "afterOrderIssued",
      "renderOrderPdf", "supplierContactEmails", "rerouteAfterOrderCancelInTx", "deriveSupplierCode", "withIdSuffix", "redactSupplier",    ]);
    const modules = { budgets, revenue, templates, categories, products, suppliers, requests, orders };
    const writes = Object.values(modules).flatMap((m) => Object.entries(m))
      .filter(([k, v]) => typeof v === "function" && /^(create|update|upsert|delete|submit|decide|new|reallocate|freeze|unfreeze|close|sign|reopen|discard|archive|redact|amend|transition|add|remove|set|raise|send|receive|confirm|undo|cancel|convert|import|propose|save|realign)/.test(k))
      .map(([k]) => k);
    const covered = new Set(Object.keys(attacks()));
    const uncovered = writes.filter((k) => !covered.has(k) && !noId.has(k));
    expect(uncovered).toEqual([]);
  });
});
