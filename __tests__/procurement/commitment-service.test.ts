/**
 * The purchase order service with the db mocked: issuing takes a PO number
 * inside the transaction, copies the request into one order line, marks the
 * request ordered and raises the line's committed figures; the manual raise
 * is the requester's or an admin's and emails the supplier only when the
 * request asked for it; a supplier's approval converts every request waiting
 * on it, one transaction each; receiving is the requester's mark and a full
 * receipt above AED 50,000 needs a second person who is not the receiver;
 * cancel releases the line and returns the request to approved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  spendRequest: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  commitment: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  commitmentCounter: { upsert: vi.fn().mockResolvedValue({ lastSerial: 3 }) },
  eventBudget: { findFirst: vi.fn() },
  budgetLine: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  organization: { findUnique: vi.fn() },
  user: { findMany: vi.fn().mockResolvedValue([]) },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
const recompute = vi.hoisted(() => vi.fn());
vi.mock("@/procurement/services/budget-service", () => ({ recomputeBudgetTotals: recompute }));
const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({ sendEmail }));
vi.mock("@/procurement/lib/commitment-pdf", () => ({ generatePurchaseOrderPdf: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.4 sample")) }));

import {
  cancelOrder,
  confirmReceipt,
  convertRequestsAwaitingSupplier,
  issueOrderInTx,
  raiseOrder,
  receiveOrder,
  sendOrderToSupplier,
  supplierContactEmails,
  toCommitmentView,
} from "@/procurement/services/commitment-service";

const ORG = "org-1";
const requester = { id: "req", isAdmin: false, canRequest: true, canSettle: false, canApprove: false };
const settle = { id: "muthu", isAdmin: false, canRequest: false, canSettle: true, canApprove: false };
const approver = { id: "lina", isAdmin: false, canRequest: false, canSettle: false, canApprove: true };
const admin = { id: "root", isAdmin: true, canRequest: false, canSettle: false, canApprove: false };
const stranger = { id: "who", isAdmin: false, canRequest: true, canSettle: false, canApprove: false };

const request = (over: Record<string, unknown> = {}) => ({
  id: "sr1", requestNo: "PR-2026-0007", budgetId: "b1", lineKey: "k-av", eventCode: "HM2026", requesterUserId: "req", supplierId: "s1", title: "LED wall",
  amount: "1000.0000", taxAmount: "50.0000", currency: "EUR", fxRateToReporting: "4.2", amountAed: "4200.0000", categoryId: "c-av", status: "APPROVED", linkedCommitmentId: null, emailSupplierOnIssue: false, version: 3,
  supplier: { id: "s1", approvalStatus: "APPROVED", isActive: true },
  ...over,
});
const line = (over: Record<string, unknown> = {}) => ({ id: "l1", committedOpen: "500.0000", committedTotal: "700.0000", taxRatePercent: "5", taxCode: null, ...over });
const commitment = (over: Record<string, unknown> = {}) => ({
  id: "c1", organizationId: ORG, commitmentNo: "PO-2026-0003", spendRequestId: "sr1", budgetId: "b1", lineKey: "k-av", supplierId: "s1", eventCode: "HM2026",
  amount: "1000.0000", taxAmount: "50.0000", currency: "EUR", fxRateToReporting: "4.2", status: "APPROVED", fulfillmentStatus: "OPEN", accountingSyncStatus: "PENDING",
  approvedAt: new Date("2026-09-15T08:00:00Z"), approvedByUserId: "lina", sentToSupplierAt: null, receivedAt: null, receivedByUserId: null, receiptConfirmedAt: null, receiptConfirmedByUserId: null,
  cancelledAt: null, cancelledByUserId: null, cancelReason: null, closedAt: null, version: 1, createdAt: new Date(), updatedAt: new Date(),
  supplier: { id: "s1", code: "GULFAV", displayName: "Gulf AV", legalName: "Gulf Audio Visual LLC", contacts: [{ name: "Sara", email: "sara@example.test" }], country: "AE", currency: "AED", paymentTerms: "30 days", approvalStatus: "APPROVED", isActive: true },
  spendRequest: { id: "sr1", requestNo: "PR-2026-0007", title: "LED wall", requesterUserId: "req", amountAed: "4200.0000", emailSupplierOnIssue: false },
  budget: { id: "b1", eventCode: "HM2026", versionNo: 1, status: "ACTIVE", reportingCurrency: "AED", event: { name: "Hematology Summit" } },
  lines: [{ id: "cl1", lineKey: "k-av", categoryId: "c-av", description: "LED wall", qty: "1.0000", unitCost: "1000.0000", taxCode: null, taxRatePercent: "5", amount: "1000.0000", taxAmount: "50.0000", sortOrder: 0 }],
  ...over,
});
const audits = () => mockDb.auditLog.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.spendRequest.findFirst.mockResolvedValue(request());
  mockDb.spendRequest.findMany.mockResolvedValue([]);
  mockDb.spendRequest.updateMany.mockResolvedValue({ count: 1 });
  mockDb.commitment.create.mockResolvedValue({ id: "c1" });
  mockDb.commitment.findFirst.mockResolvedValue(commitment());
  mockDb.commitment.updateMany.mockResolvedValue({ count: 1 });
  mockDb.commitmentCounter.upsert.mockResolvedValue({ lastSerial: 3 });
  mockDb.eventBudget.findFirst.mockResolvedValue({ id: "b1", status: "ACTIVE", reportingCurrency: "AED" });
  mockDb.budgetLine.findFirst.mockResolvedValue(line());
  mockDb.organization.findUnique.mockResolvedValue({ name: "MM Group", logo: null, companyName: "Meeting Minds FZ LLC", companyAddress: null, companyCity: null, companyState: null, companyZipCode: null, companyCountry: null, companyPhone: null, companyEmail: null, taxId: null });
  mockDb.user.findMany.mockResolvedValue([]);
  sendEmail.mockResolvedValue({ success: true, messageId: "m1" });
});

describe("issueOrderInTx", () => {
  it("takes the PO number in the transaction, copies the request into one line, marks it ordered and raises the line's committed figures in the reporting currency", async () => {
    const out = await issueOrderInTx(mockDb as never, { organizationId: ORG, actorUserId: "lina", source: "ui", requestId: "sr1" });
    expect(out).toMatchObject({ ok: true, commitmentId: "c1", commitmentNo: "PO-2026-0003" });
    expect(mockDb.commitmentCounter.upsert).toHaveBeenCalledTimes(1);
    const data = mockDb.commitment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ commitmentNo: "PO-2026-0003", spendRequestId: "sr1", budgetId: "b1", lineKey: "k-av", supplierId: "s1", eventCode: "HM2026", amount: "1000.0000", taxAmount: "50.0000", currency: "EUR", fxRateToReporting: "4.2", status: "APPROVED", fulfillmentStatus: "OPEN", accountingSyncStatus: "PENDING", approvedByUserId: "lina" });
    expect(data.lines.create[0]).toMatchObject({ lineKey: "k-av", categoryId: "c-av", description: "LED wall", qty: "1", unitCost: "1000.0000", amount: "1000.0000", taxAmount: "50.0000", taxRatePercent: "5" });
    expect(mockDb.spendRequest.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "sr1", status: { in: ["APPROVED", "AWAITING_SUPPLIER"] }, linkedCommitmentId: null }, data: { status: "CONVERTED", linkedCommitmentId: "c1" } });
    // 1,000 EUR at 4.2 = 4,200 AED on top of 500 open and 700 total.
    expect(mockDb.budgetLine.update.mock.calls[0][0]).toMatchObject({ where: { id: "l1" }, data: { committedOpen: "4700.0000", committedTotal: "4900.0000" } });
    expect(recompute).toHaveBeenCalledWith(mockDb, "b1");
    expect(audits().map((a) => [a.entityType, a.action])).toEqual([["Commitment", "CREATE"], ["SpendRequest", "CONVERT"]]);
    expect(audits()[0].changes).toMatchObject({ commitmentNo: "PO-2026-0003", requestNo: "PR-2026-0007", amountReporting: "4200.0000" });
  });
  it("refuses a request that is not approved, one whose supplier is not approved or inactive, one already ordered, and a budget that no longer takes orders", async () => {
    const issue = () => issueOrderInTx(mockDb as never, { organizationId: ORG, actorUserId: "lina", source: "ui", requestId: "sr1" });
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "PENDING_APPROVAL" }));
    expect(await issue()).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "AWAITING_SUPPLIER", supplier: { id: "s1", approvalStatus: "PROPOSED", isActive: true } }));
    expect(await issue()).toMatchObject({ ok: false, code: "SUPPLIER_NOT_APPROVED" });
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ supplier: { id: "s1", approvalStatus: "APPROVED", isActive: false } }));
    expect(await issue()).toMatchObject({ ok: false, code: "SUPPLIER_NOT_APPROVED" });
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ linkedCommitmentId: "c0" }));
    expect(await issue()).toMatchObject({ ok: false, code: "ALREADY_ORDERED", meta: { commitmentId: "c0" } });
    mockDb.spendRequest.findFirst.mockResolvedValue(request());
    mockDb.eventBudget.findFirst.mockResolvedValue({ id: "b1", status: "CLOSED", reportingCurrency: "AED" });
    expect(await issue()).toMatchObject({ ok: false, code: "BUDGET_NOT_ACTIVE" });
    expect(mockDb.commitment.create).not.toHaveBeenCalled();
  });
  it("a lost claim on the request is STALE_WRITE, after the number and the row were taken, so the caller rolls back", async () => {
    mockDb.spendRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await issueOrderInTx(mockDb as never, { organizationId: ORG, actorUserId: "lina", source: "ui", requestId: "sr1" })).toMatchObject({ ok: false, code: "STALE_WRITE" });
    expect(mockDb.budgetLine.update).not.toHaveBeenCalled();
  });
});

describe("raiseOrder (the by-hand path)", () => {
  it("is the requester's with the grant or an admin's, never a stranger's", async () => {
    expect(await raiseOrder({ organizationId: ORG, actor: stranger, source: "ui", requestId: "sr1" })).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    expect(await raiseOrder({ organizationId: ORG, actor: settle, source: "ui", requestId: "sr1" })).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    expect(mockDb.commitment.create).not.toHaveBeenCalled();
    const r = await raiseOrder({ organizationId: ORG, actor: requester, source: "ui", requestId: "sr1" });
    expect(r.ok).toBe(true);
    expect(mockDb.commitment.create).toHaveBeenCalledTimes(1);
    const a = await raiseOrder({ organizationId: ORG, actor: admin, source: "ui", requestId: "sr1" });
    expect(a.ok).toBe(true);
  });
  it("emails the supplier only when the request asked for it, after the order committed, and never fails the order over the email", async () => {
    const r = await raiseOrder({ organizationId: ORG, actor: requester, source: "ui", requestId: "sr1" });
    expect(r.ok).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
    mockDb.commitment.findFirst.mockResolvedValue(commitment({ spendRequest: { id: "sr1", requestNo: "PR-2026-0007", title: "LED wall", requesterUserId: "req", amountAed: "4200.0000", emailSupplierOnIssue: true } }));
    sendEmail.mockRejectedValueOnce(new Error("SES down"));
    const r2 = await raiseOrder({ organizationId: ORG, actor: requester, source: "ui", requestId: "sr1" });
    expect(r2.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(mockDb.commitment.updateMany.mock.calls.some((c) => c[0].data?.sentToSupplierAt)).toBe(false);
    const r3 = await raiseOrder({ organizationId: ORG, actor: requester, source: "ui", requestId: "sr1" });
    expect(r3.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(mockDb.commitment.updateMany.mock.calls.some((c) => c[0].data?.sentToSupplierAt)).toBe(true);
  });
});

describe("convertRequestsAwaitingSupplier", () => {
  it("issues an order for every request waiting on the supplier, one transaction each, and a failure on one never stops the next", async () => {
    mockDb.spendRequest.findMany.mockResolvedValue([{ id: "srA" }, { id: "srB" }]);
    mockDb.spendRequest.findFirst
      .mockResolvedValueOnce(request({ id: "srA", status: "AWAITING_SUPPLIER", supplier: { id: "s1", approvalStatus: "APPROVED", isActive: true } }))
      .mockResolvedValueOnce(request({ id: "srB", status: "AWAITING_SUPPLIER", linkedCommitmentId: "c9" }));
    const out = await convertRequestsAwaitingSupplier({ organizationId: ORG, supplierId: "s1", actorUserId: "muthu", source: "ui" });
    expect(mockDb.spendRequest.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: ORG, supplierId: "s1", status: "AWAITING_SUPPLIER", linkedCommitmentId: null });
    expect(out).toEqual({ issued: ["c1"], failed: ["srB"] });
  });
});

describe("sendOrderToSupplier", () => {
  it("needs a contact email, a live order and the right person; then emails the PDF, stamps the send and audits the recipients", async () => {
    mockDb.commitment.findFirst.mockResolvedValueOnce(commitment({ supplier: { ...commitment().supplier, contacts: [{ name: "Nobody" }] } }));
    expect(await sendOrderToSupplier({ organizationId: ORG, actor: requester, source: "ui", commitmentId: "c1" })).toMatchObject({ ok: false, code: "NO_SUPPLIER_EMAIL" });
    mockDb.commitment.findFirst.mockResolvedValueOnce(commitment({ status: "CANCELLED" }));
    expect(await sendOrderToSupplier({ organizationId: ORG, actor: requester, source: "ui", commitmentId: "c1" })).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    expect(await sendOrderToSupplier({ organizationId: ORG, actor: stranger, source: "ui", commitmentId: "c1" })).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    expect(sendEmail).not.toHaveBeenCalled();
    const r = await sendOrderToSupplier({ organizationId: ORG, actor: requester, source: "ui", commitmentId: "c1" });
    expect(r.ok).toBe(true);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toEqual([{ email: "sara@example.test", name: "Sara" }]);
    expect(mail.subject).toBe("Purchase order PO-2026-0003 from Meeting Minds FZ LLC");
    expect(mail.attachments[0]).toMatchObject({ name: "PO-2026-0003.pdf", contentType: "application/pdf" });
    expect(mail.htmlContent).toContain("EUR 1000.00 ex-VAT, VAT EUR 50.00");
    expect(mail.logContext).toMatchObject({ entityType: "OTHER", entityId: "c1", templateSlug: "purchase-order", triggeredByUserId: "req" });
    expect(mockDb.commitment.updateMany.mock.calls.at(-1)![0].data.sentToSupplierAt).toBeInstanceOf(Date);
    expect(audits().at(-1)).toMatchObject({ entityType: "Commitment", action: "SEND", changes: { to: ["sara@example.test"] } });
  });
  it("a refused send is SEND_FAILED and stamps nothing", async () => {
    sendEmail.mockResolvedValueOnce({ success: false, error: "MessageRejected" });
    expect(await sendOrderToSupplier({ organizationId: ORG, actor: settle, source: "ui", commitmentId: "c1" })).toMatchObject({ ok: false, code: "SEND_FAILED" });
    expect(mockDb.commitment.updateMany).not.toHaveBeenCalled();
  });
});

describe("receiving", () => {
  const receive = (actor = requester, extent: "PARTIAL" | "FULL" = "FULL") => receiveOrder({ organizationId: ORG, actor, source: "ui", commitmentId: "c1", extent, expectedVersion: 1 });
  it("a partial receipt marks the order partly received without a receiver; a full receipt records who and when", async () => {
    expect((await receive(requester, "PARTIAL")).ok).toBe(true);
    expect(mockDb.commitment.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "c1", status: "APPROVED", version: 1 }, data: { fulfillmentStatus: "PARTIALLY_RECEIVED" } });
    expect(mockDb.commitment.updateMany.mock.calls[0][0].data.receivedByUserId).toBeUndefined();
    expect((await receive(requester, "FULL")).ok).toBe(true);
    expect(mockDb.commitment.updateMany.mock.calls[1][0].data).toMatchObject({ fulfillmentStatus: "RECEIVED", receivedByUserId: "req" });
  });
  it("names whether the second-person rule applies: not below AED 50,000, yes from it", async () => {
    mockDb.commitment.findFirst.mockResolvedValueOnce(commitment({ spendRequest: { ...commitment().spendRequest, amountAed: "4200.0000" } }));
    await receive(requester, "FULL");
    expect(audits().at(-1)!.changes).toMatchObject({ extent: "FULL", needsSecondPerson: false });
    mockDb.commitment.findFirst.mockResolvedValueOnce(commitment({ spendRequest: { ...commitment().spendRequest, amountAed: "50000.0000" } }));
    await receive(settle, "FULL");
    expect(audits().at(-1)!.changes).toMatchObject({ extent: "FULL", needsSecondPerson: true });
  });
  it("is the requester's, the settle holder's or an admin's; refuses a received or cancelled order and a lost claim", async () => {
    expect(await receive(stranger)).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    expect((await receive(admin)).ok).toBe(true);
    mockDb.commitment.findFirst.mockResolvedValueOnce(commitment({ fulfillmentStatus: "RECEIVED", receivedByUserId: "req" }));
    expect(await receive(settle)).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    mockDb.commitment.findFirst.mockResolvedValueOnce(commitment({ status: "CANCELLED" }));
    expect(await receive(settle)).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    mockDb.commitment.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await receive(settle)).toMatchObject({ ok: false, code: "STALE_WRITE" });
  });
});

describe("confirmReceipt (the second person above AED 50,000)", () => {
  const received = (over: Record<string, unknown> = {}) => commitment({ fulfillmentStatus: "RECEIVED", receivedAt: new Date(), receivedByUserId: "req", spendRequest: { ...commitment().spendRequest, amountAed: "60000.0000" }, ...over });
  const confirm = (actor: typeof settle) => confirmReceipt({ organizationId: ORG, actor, source: "ui", commitmentId: "c1", expectedVersion: 1 });
  it("the settle holder or an approver confirms; the receiver, a requester and an order below the floor are refused", async () => {
    mockDb.commitment.findFirst.mockResolvedValueOnce(received({ receivedByUserId: "muthu" }));
    expect(await confirm(settle)).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    mockDb.commitment.findFirst.mockResolvedValueOnce(received());
    expect(await confirm(requester)).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    mockDb.commitment.findFirst.mockResolvedValueOnce(received({ spendRequest: { ...commitment().spendRequest, amountAed: "4200.0000" } }));
    expect(await confirm(settle)).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    mockDb.commitment.findFirst.mockResolvedValueOnce(commitment());
    expect(await confirm(settle)).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    expect(mockDb.commitment.updateMany).not.toHaveBeenCalled();
    mockDb.commitment.findFirst.mockResolvedValueOnce(received());
    expect((await confirm(settle)).ok).toBe(true);
    expect(mockDb.commitment.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "c1", fulfillmentStatus: "RECEIVED", receiptConfirmedAt: null, version: 1 }, data: { receiptConfirmedByUserId: "muthu" } });
    mockDb.commitment.findFirst.mockResolvedValueOnce(received());
    expect((await confirm(approver)).ok).toBe(true);
    expect(audits().at(-1)).toMatchObject({ entityType: "Commitment", action: "CONFIRM_RECEIPT", changes: { receivedByUserId: "req", amountAed: "60000.0000" } });
  });
  it("an already confirmed receipt is not confirmed twice", async () => {
    mockDb.commitment.findFirst.mockResolvedValueOnce(received({ receiptConfirmedAt: new Date(), receiptConfirmedByUserId: "lina" }));
    expect(await confirm(settle)).toMatchObject({ ok: false, code: "INVALID_STATUS" });
  });
});

describe("cancelOrder (close and release)", () => {
  const cancel = (actor: typeof settle, reason: string | null = "Supplier withdrew") => cancelOrder({ organizationId: ORG, actor, source: "ui", commitmentId: "c1", reason, expectedVersion: 1 });
  it("is the settle holder's or an admin's, with a reason, on a live order only", async () => {
    expect(await cancel(requester)).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    expect(await cancel(approver)).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    expect(await cancel(settle, "  ")).toMatchObject({ ok: false, code: "REASON_REQUIRED" });
    mockDb.commitment.findFirst.mockResolvedValueOnce(commitment({ status: "CANCELLED" }));
    expect(await cancel(settle)).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    expect(mockDb.commitment.updateMany).not.toHaveBeenCalled();
  });
  it("cancels the order, releases what it held on the line (never below zero), returns the request to approved and audits both", async () => {
    mockDb.budgetLine.findFirst.mockResolvedValue({ id: "l1", committedOpen: "4700.0000", committedTotal: "4000.0000" });
    const r = await cancel(admin);
    expect(r.ok).toBe(true);
    expect(mockDb.commitment.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "c1", status: "APPROVED", version: 1 }, data: { status: "CANCELLED", cancelledByUserId: "root", cancelReason: "Supplier withdrew" } });
    expect(mockDb.budgetLine.update.mock.calls[0][0]).toMatchObject({ where: { id: "l1" }, data: { committedOpen: "500.0000", committedTotal: "0.0000" } });
    expect(recompute).toHaveBeenCalledWith(mockDb, "b1");
    expect(mockDb.spendRequest.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "sr1", status: "CONVERTED", linkedCommitmentId: "c1" }, data: { status: "APPROVED", linkedCommitmentId: null } });
    expect(audits().map((a) => [a.entityType, a.action])).toEqual([["SpendRequest", "ORDER_CANCELLED"], ["Commitment", "CANCEL"]]);
    expect(audits()[1].changes).toMatchObject({ reason: "Supplier withdrew", released: "4200.0000" });
  });
  it("a lost claim is STALE_WRITE and nothing else moves", async () => {
    mockDb.commitment.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await cancel(settle)).toMatchObject({ ok: false, code: "STALE_WRITE" });
    expect(mockDb.budgetLine.update).not.toHaveBeenCalled();
    expect(mockDb.spendRequest.updateMany).not.toHaveBeenCalled();
  });
});

describe("views", () => {
  it("supplierContactEmails reads the JSON defensively and toCommitmentView derives the reporting figure and the receiving flags", () => {
    expect(supplierContactEmails([{ name: "A", email: "a@x.test" }, { name: "B" }, null, "junk", { email: 5 }])).toEqual([{ name: "A", email: "a@x.test" }]);
    expect(supplierContactEmails("nope")).toEqual([]);
    const v = toCommitmentView(commitment({ spendRequest: { ...commitment().spendRequest, amountAed: "60000.0000" } }) as never);
    expect(v).toMatchObject({ amountReporting: "4200.0000", amountAed: "60000.0000", statusLabel: "Issued", fulfillmentLabel: "Not received", receiptNeedsSecondPerson: true, receiptConfirmed: false });
    expect(v.supplier.contactEmails).toEqual([{ name: "Sara", email: "sara@example.test" }]);
    expect((v.supplier as { contacts?: unknown }).contacts).toBeUndefined();
  });
});
