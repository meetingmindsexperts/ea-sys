/**
 * The procurement activity describer in core, the families the Budget tab
 * added on Sep 15, 2026: spend requests, purchase orders, suppliers, the
 * catalogue, templates, the approval decisions, and the export and import
 * rows the transfer helpers write. The budget and line families are pinned by
 * `__tests__/procurement/budget-activity.test.ts` through the module's shim,
 * which is also what proves the shim.
 *
 * Two properties beyond the wording: a payload the describer does not know
 * still reads as words (never a raw constant, never a crash), and no sentence
 * carries an em dash or a supplier contact's email address.
 */
import { describe, it, expect } from "vitest";
import { describeProcurementActivity, EMPTY_DESCRIBE_CONTEXT, type ProcurementActivityRow } from "@/lib/procurement-activity";
import { describeAuditAction } from "@/components/activity/audit-log-display";

const ctx = { lineNames: {}, userNames: { u2: "Muthu", u3: "Lina" } };
const row = (entityType: string, action: string, changes: Record<string, unknown> = {}): ProcurementActivityRow => ({
  id: "a1", at: "2026-09-15T08:00:00.000Z", entityType, action, changes, actor: null,
});
const d = (entityType: string, action: string, changes: Record<string, unknown> = {}) => describeProcurementActivity(row(entityType, action, changes), ctx);

describe("spend requests", () => {
  it("draft, edit, submit", () => {
    expect(d("SpendRequest", "CREATE", { requestNo: "PR-2026-0001", amount: "5000.0000", currency: "aed" })).toEqual({ title: "Request drafted", detail: "AED 5,000.00" });
    expect(d("SpendRequest", "UPDATE", { fields: ["title", "neededBy", "sourcingMethod"] })).toEqual({ title: "Request edited", detail: "title, needed by, sourcing" });
    expect(d("SpendRequest", "SUBMIT", { amountAed: "5000.0000", budgetCheck: "WITHIN_BUDGET", exception: false })).toEqual({ title: "Request submitted", detail: "AED 5,000.00, within budget" });
    expect(d("SpendRequest", "SUBMIT", { amountAed: "40000.0000", budgetCheck: "OVER_BUDGET", exception: true })).toEqual({ title: "Request submitted", detail: "AED 40,000.00, over budget, to the final approver" });
    expect(d("SpendRequest", "SUBMIT", { amountAed: "1.0000", budgetCheck: "FROZEN", exception: true }).detail).toBe("AED 1.00, budget frozen, to the final approver");
  });
  it("the decision says where the request landed", () => {
    expect(d("SpendRequest", "APPROVE", { landing: "APPROVED", note: "Go" })).toEqual({ title: "Request approved", detail: "note: Go" });
    expect(d("SpendRequest", "APPROVE", { landing: "AWAITING_SUPPLIER", note: null })).toEqual({ title: "Request approved, waiting on its supplier", detail: null });
    expect(d("SpendRequest", "REJECT", { note: "Too much" })).toEqual({ title: "Request rejected", detail: "note: Too much" });
  });
  it("amount changes: a fall applies at once, a rise is routed and decided", () => {
    expect(d("SpendRequest", "AMEND", { previousAmount: "6000.0000", nextAmount: "4000.0000", reason: "Smaller screen" })).toEqual({ title: "Amount reduced", detail: "6,000.00 to 4,000.00, reason: Smaller screen" });
    expect(d("SpendRequest", "AMENDMENT_REQUESTED", { previousAmount: "5000", nextAmount: "6000", budgetCheck: "WITHIN_BUDGET", reason: "Bigger screen" })).toEqual({ title: "Amount change sent for approval", detail: "5,000.00 to 6,000.00, within budget, reason: Bigger screen" });
    expect(d("SpendRequest", "AMENDMENT_APPROVED", { previousAmount: "5000", nextAmount: "6000", note: null })).toEqual({ title: "Amount change approved", detail: "5,000.00 to 6,000.00" });
    expect(d("SpendRequest", "AMENDMENT_REJECTED", { previousAmount: "5000", nextAmount: "6000", note: "No" })).toEqual({ title: "Amount change rejected", detail: "5,000.00 to 6,000.00, note: No" });
  });
  it("withdraw, cancel, quotes and files", () => {
    expect(d("SpendRequest", "WITHDRAW", { from: "PENDING_APPROVAL", reason: null })).toEqual({ title: "Request withdrawn", detail: null });
    expect(d("SpendRequest", "CANCEL", { from: "APPROVED", reason: "Vendor withdrew" })).toEqual({ title: "Request cancelled", detail: "reason: Vendor withdrew" });
    expect(d("SpendRequest", "QUOTE_ADDED", { vendorName: "Gulf AV", amount: "4800.0000", currency: "AED", recommended: true })).toEqual({ title: "Quote added", detail: "Gulf AV, AED 4,800.00, recommended" });
    expect(d("SpendRequest", "QUOTE_REMOVED", { quoteId: "q1" })).toEqual({ title: "Quote removed", detail: null });
    expect(d("SpendRequest", "QUOTE_FILE_ATTACHED", { fileName: "quote.pdf", fileSize: 12000 })).toEqual({ title: "Quote document attached", detail: "quote.pdf" });
    expect(d("SpendRequest", "QUOTE_FILE_REMOVED", { fileName: null })).toEqual({ title: "Quote document removed", detail: null });
  });
  it("the order rows written against the request", () => {
    expect(d("SpendRequest", "CONVERT", { commitmentNo: "PO-2026-0001", from: "PENDING_APPROVAL" })).toEqual({ title: "Purchase order issued", detail: "PO-2026-0001" });
    expect(d("SpendRequest", "ORDER_CANCELLED", { commitmentNo: "PO-2026-0001", reason: "Duplicate" })).toEqual({ title: "Purchase order cancelled, request back to approved", detail: "PO-2026-0001, reason: Duplicate" });
  });
});

describe("purchase orders", () => {
  it("issue, send, receive, confirm, cancel", () => {
    expect(d("Commitment", "CREATE", { commitmentNo: "PO-2026-0001", requestNo: "PR-2026-0001", amount: "36000.0000", taxAmount: "1800.0000", currency: "AED" })).toEqual({ title: "Order issued", detail: "AED 36,000.00, VAT 1,800.00, for PR-2026-0001" });
    expect(d("Commitment", "CREATE", { amount: "500", taxAmount: "0", currency: "AED" }).detail).toBe("AED 500.00");
    expect(d("Commitment", "SEND", { to: ["sara@example.test", "ali@example.test"] })).toEqual({ title: "Order emailed to the supplier", detail: "2 recipients" });
    expect(d("Commitment", "RECEIVE", { extent: "PARTIAL", needsSecondPerson: false })).toEqual({ title: "Marked partly received", detail: null });
    expect(d("Commitment", "RECEIVE", { extent: "FULL", needsSecondPerson: true })).toEqual({ title: "Marked received", detail: "a second person must confirm" });
    expect(d("Commitment", "CONFIRM_RECEIPT", { receivedByUserId: "u2", amountAed: "60000.0000" })).toEqual({ title: "Receipt confirmed", detail: "AED 60,000.00, received by Muthu" });
    expect(d("Commitment", "CANCEL", { released: "5000.0000", reason: "Duplicate" })).toEqual({ title: "Order cancelled", detail: "5,000.00 released, reason: Duplicate" });
  });
  it("never puts a supplier contact's address into the sentence", () => {
    const s = d("Commitment", "SEND", { to: ["sara@example.test"] });
    expect(`${s.title} ${s.detail}`).not.toContain("@");
  });
});

describe("suppliers, catalogue, templates", () => {
  it("supplier lifecycle; the classified pair appears as field names only", () => {
    expect(d("Supplier", "CREATE", { code: "GULFAV", displayName: "Gulf AV", currency: "AED" })).toEqual({ title: "Supplier added", detail: "code GULFAV, AED" });
    expect(d("Supplier", "PROPOSE", { code: "S2", displayName: "S Two", currency: "USD" })).toEqual({ title: "Supplier proposed", detail: "code S2, USD" });
    expect(d("Supplier", "APPROVE", { code: "S2", note: "Checked" })).toEqual({ title: "Supplier approved", detail: "code S2, note: Checked" });
    expect(d("Supplier", "REJECT", { code: "S2", note: null })).toEqual({ title: "Supplier rejected", detail: "code S2" });
    expect(d("Supplier", "UPDATE", { code: "S2", fields: ["taxRegistrationNo", "bankDetails", "paymentTerms"] })).toEqual({ title: "Supplier edited", detail: "code S2, tax registration number, bank details, payment terms" });
    expect(d("Supplier", "RESTORE", { code: "S2", fields: ["isActive"], isActive: true })).toEqual({ title: "Supplier restored", detail: "code S2" });
    expect(d("Supplier", "DEACTIVATE", { code: "S2", fields: ["isActive"], isActive: false })).toEqual({ title: "Supplier deactivated", detail: "code S2" });
  });
  it("products and categories", () => {
    expect(d("BudgetProduct", "CREATE", { sku: "AV-001", name: "LED wall", categoryCode: "AV" })).toEqual({ title: "Product added", detail: "SKU AV-001, category AV" });
    expect(d("BudgetProduct", "UPDATE", { sku: "AV-001", fields: ["name", "unitPrice"] })).toEqual({ title: "Product edited", detail: "SKU AV-001, name, unit price" });
    expect(d("BudgetProduct", "ARCHIVE", { sku: "AV-001" })).toEqual({ title: "Product archived", detail: "SKU AV-001" });
    expect(d("BudgetProduct", "RESTORE", { sku: "AV-001" })).toEqual({ title: "Product restored", detail: "SKU AV-001" });
    expect(d("BudgetCategory", "CREATE", { code: "AV", name: "Audio visual" })).toEqual({ title: "Category added", detail: "code AV" });
    expect(d("BudgetCategory", "ARCHIVE", { code: "AV", isActive: false })).toEqual({ title: "Category archived", detail: "code AV" });
    expect(d("BudgetCategory", "RESTORE", { code: "AV", isActive: true })).toEqual({ title: "Category restored", detail: "code AV" });
  });
  it("templates", () => {
    expect(d("BudgetTemplate", "CREATE", { name: "Conference standard", eventType: "CONFERENCE" })).toEqual({ title: "Template created", detail: "for conference events" });
    expect(d("BudgetTemplate", "UPDATE", { fields: ["name", "isActive"] })).toEqual({ title: "Template edited", detail: "name, active" });
    expect(d("BudgetTemplate", "ADD_LINE", { lineId: null })).toEqual({ title: "Template line added", detail: null });
    expect(d("BudgetTemplate", "UPDATE_LINE", { lineId: "l1" })).toEqual({ title: "Template line edited", detail: null });
    expect(d("BudgetTemplate", "REMOVE_LINE", { lineId: "l1" })).toEqual({ title: "Template line removed", detail: null });
  });
});

describe("approval decisions and the final-approver route", () => {
  it("granted and refused carry the AED figure and the note", () => {
    expect(d("ApprovalRequest", "APPROVAL_GRANTED", { subjectType: "SPEND_REQUEST", subjectId: "sr1", amountAed: "5000.0000", note: null })).toEqual({ title: "Approval granted", detail: "AED 5,000.00" });
    expect(d("ApprovalRequest", "APPROVAL_REJECTED", { subjectType: "BUDGET", subjectId: "b1", amountAed: "125000.0000", note: "Trim AV" })).toEqual({ title: "Approval refused", detail: "AED 125,000.00, note: Trim AV" });
  });
  it("a request routed as an exception says so", () => {
    expect(d("ApprovalRequest", "APPROVAL_REQUESTED", { assigneeUserId: "u3", amountAed: "40000.0000", requireFinalApprover: true, superseded: [] })).toEqual({ title: "Routed to Lina for approval", detail: "AED 40,000.00, final approver only" });
  });
});

describe("exports and imports, written by the shared transfer helpers", () => {
  it("a budget export counts rows; a catalogue import counts outcomes", () => {
    expect(d("EventBudget", "EXPORT", { format: "csv", rowCount: 14, filters: { budgetId: "b1" } })).toEqual({ title: "Budget exported", detail: "14 rows, CSV" });
    expect(d("EventBudget", "EXPORT", { rowCount: 1 })).toEqual({ title: "Budget exported", detail: "1 row" });
    expect(d("BudgetProduct", "IMPORT", { format: "csv", totalProcessed: 203, created: 200, updated: 3, skipped: 0, errors: 2 })).toEqual({ title: "Products imported", detail: "200 created, 3 updated, 0 skipped, 2 errors, CSV" });
    expect(d("Supplier", "IMPORT", { totalProcessed: 5, created: 5 })).toEqual({ title: "Suppliers imported", detail: "5 created" });
  });
});

describe("robustness", () => {
  it("an action nobody taught it still reads as words", () => {
    expect(d("SpendRequest", "SOMETHING_NEW", {})).toEqual({ title: "something new", detail: null });
    expect(d("Commitment", "REPRICED", {})).toEqual({ title: "repriced", detail: null });
    expect(d("Unknown", "CREATE", {})).toEqual({ title: "create", detail: null });
  });
  it("a header edit names the not-applicable marking and the benchmark in words", () => {
    expect(d("EventBudget", "UPDATE", { fields: ["naCategoryCodes", "benchmarkSourceType", "financeOwnerUserId"] })).toEqual({ title: "Details edited", detail: "categories marked not applicable, benchmark source, finance owner" });
  });
  it("runs with the empty context by default", () => {
    expect(describeProcurementActivity(row("Commitment", "CONFIRM_RECEIPT", { receivedByUserId: "u9" }))).toEqual({ title: "Receipt confirmed", detail: null });
    expect(EMPTY_DESCRIBE_CONTEXT).toEqual({ lineNames: {}, userNames: {} });
  });
  it("the generic display describer reaches the same title for a procurement row, and leaves other rows alone", () => {
    expect(describeAuditAction({ entityType: "SpendRequest", action: "SUBMIT", entityId: "sr1", changes: { amountAed: "5000" }, user: null })).toBe("Request submitted");
    expect(describeAuditAction({ entityType: "EventBudget", action: "CREATE", entityId: "b1", changes: {}, user: null })).toBe("Budget created");
    expect(describeAuditAction({ entityType: "Registration", action: "UPDATE", entityId: "r1", changes: {}, user: null })).toBe("Registration updated");
  });
  it("never writes an em dash into a sentence", () => {
    const rows: Array<[string, string, Record<string, unknown>]> = [
      ["SpendRequest", "SUBMIT", { amountAed: "1", budgetCheck: "OVER_BUDGET", exception: true }],
      ["SpendRequest", "AMENDMENT_REQUESTED", { previousAmount: "1", nextAmount: "2", reason: "r" }],
      ["Commitment", "CREATE", { amount: "1", taxAmount: "1", currency: "AED", requestNo: "PR-1" }],
      ["Commitment", "CANCEL", { released: "1", reason: "r" }],
      ["Supplier", "UPDATE", { code: "c", fields: ["bankDetails"] }],
      ["BudgetProduct", "CREATE", { sku: "s", categoryCode: "c" }],
      ["BudgetTemplate", "CREATE", { eventType: "HYBRID" }],
      ["ApprovalRequest", "APPROVAL_REJECTED", { amountAed: "1", note: "n" }],
      ["EventBudget", "EXPORT", { rowCount: 2, format: "csv" }],
      ["Supplier", "IMPORT", { created: 1, updated: 1, skipped: 1, errors: 1, format: "csv" }],
    ];
    for (const [t, a, c] of rows) {
      const s = d(t, a, c);
      expect(`${s.title} ${s.detail ?? ""}`).not.toMatch(/\u2014/);
    }
  });
});

describe("delegation and escalation rows, written by the approval-escalation job", () => {
  it("a delegate at 48 hours: who, after how long, and that the assignee still can", () => {
    expect(d("ApprovalRequest", "APPROVAL_DELEGATED", { fromUserId: "u3", toUserId: "u2", via: "configured", afterHours: 49 }))
      .toEqual({ title: "Passed to Muthu as well", detail: "after 2 days without a decision, Lina can still decide it, chosen as their named delegate" });
    expect(d("ApprovalRequest", "APPROVAL_DELEGATED", { fromUserId: "gone", toUserId: "gone2", via: "next-tier", afterHours: 48 }))
      .toEqual({ title: "Passed to a delegate as well", detail: "after 2 days without a decision, chosen from the next tier" });
  });
  it("an escalation at 96 hours, and one because the assignee lost authority", () => {
    expect(d("ApprovalRequest", "APPROVAL_ESCALATED", { fromUserId: "u3", toUserId: "u2", reason: "no-decision", afterHours: 97 }))
      .toEqual({ title: "Escalated to Muthu", detail: "after 4 days without a decision, from Lina" });
    expect(d("ApprovalRequest", "APPROVAL_ESCALATED", { fromUserId: "u3", toUserId: "u2", reason: "assignee-lost-authority", afterHours: 2 }))
      .toEqual({ title: "Escalated to Muthu", detail: "Lina no longer has the authority to decide it" });
    expect(describeProcurementActivity(row("ApprovalRequest", "APPROVAL_ESCALATED", { reason: "no-decision" })))
      .toEqual({ title: "Escalated to the next tier", detail: null });
  });
});
