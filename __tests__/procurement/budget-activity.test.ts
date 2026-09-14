/**
 * The activity describer: every audit action the budget service and the
 * approvals primitive write has a sentence, line keys resolve to the line's
 * description, an assignee id resolves to a name, and an action nobody
 * taught it still reads as words rather than as a constant.
 */
import { describe, it, expect } from "vitest";
import { describeBudgetActivity, type BudgetActivityRow } from "@/procurement/lib/budget-activity";

const ctx = { lineNames: { venue: "Venue hire", av: "Audio visual" }, userNames: { u2: "Muthu" } };
const row = (entityType: string, action: string, changes: Record<string, unknown> = {}): BudgetActivityRow => ({
  id: "a1", at: "2026-09-14T08:00:00.000Z", entityType, action, changes, actor: { name: "Krishna", email: "k@x.test" },
});

describe("describeBudgetActivity: the budget's own rows", () => {
  it("creation says where the lines came from", () => {
    expect(describeBudgetActivity(row("EventBudget", "CREATE", { templateId: "t1", seededLines: 12, reportingCurrency: "AED" }), ctx))
      .toEqual({ title: "Budget created", detail: "seeded from a template, 12 lines, reporting in AED" });
    expect(describeBudgetActivity(row("EventBudget", "CREATE", { templateId: null, seededLines: 0 }), ctx).detail).toBe("started empty");
  });
  it("a header edit lists the fields in words", () => {
    expect(describeBudgetActivity(row("EventBudget", "UPDATE", { fields: ["contingencyPercent", "expectedAttendance"] }), ctx))
      .toEqual({ title: "Details edited", detail: "contingency percent, expected attendance" });
  });
  it("submission carries the AED amount and the rate", () => {
    expect(describeBudgetActivity(row("EventBudget", "SUBMIT", { amountAed: "125000.0000", reportingToAedRate: "3.6725" }), ctx))
      .toEqual({ title: "Submitted for approval", detail: "AED 125,000.00, rate 3.6725 to AED" });
    expect(describeBudgetActivity(row("EventBudget", "SUBMIT", { amountAed: "0", reportingToAedRate: "1", rateSource: "peg" }), ctx).detail).toBe("AED 0.00");
  });
  it("approve and reject carry the note", () => {
    expect(describeBudgetActivity(row("EventBudget", "APPROVE", { versionNo: 2, note: "Go ahead" }), ctx))
      .toEqual({ title: "Approved", detail: "version 2 is now active, note: Go ahead" });
    expect(describeBudgetActivity(row("EventBudget", "REJECT", { note: null }), ctx)).toEqual({ title: "Rejected, back to draft", detail: null });
  });
  it("a move names the lines, not their keys, and says on whose authority", () => {
    expect(describeBudgetActivity(row("EventBudget", "REALLOCATE", { fromLineKey: "venue", toLineKey: "av", amount: "500.0000", reason: "AV overran", authority: "OWNER" }), ctx))
      .toEqual({ title: "Amount moved between lines", detail: "500.00 from Venue hire to Audio visual, within the owner's ten percent, reason: AV overran" });
    expect(describeBudgetActivity(row("EventBudget", "REALLOCATE", { fromLineKey: "venue", toLineKey: "gone", amount: "9000", approvalRequestId: "r1", note: "ok" }), ctx).detail)
      .toBe("9,000.00 from Venue hire to gone, an approved move, note: ok");
    expect(describeBudgetActivity(row("EventBudget", "REALLOCATION_REQUESTED", { fromLineKey: "venue", toLineKey: "av", amount: "9000", reason: "Bigger screen" }), ctx))
      .toEqual({ title: "Move sent for approval", detail: "9,000.00 from Venue hire to Audio visual, reason: Bigger screen" });
    expect(describeBudgetActivity(row("EventBudget", "REALLOCATION_REJECTED", { fromLineKey: "venue", toLineKey: "av", amount: "9000", note: "Not now" }), ctx).title).toBe("Move rejected");
  });
  it("the lifecycle transitions read as their verbs", () => {
    expect(describeBudgetActivity(row("EventBudget", "FREEZE"), ctx)).toEqual({ title: "Frozen", detail: null });
    expect(describeBudgetActivity(row("EventBudget", "UNFREEZE", { reason: "Late quote" }), ctx)).toEqual({ title: "Unfrozen", detail: "reason: Late quote" });
    expect(describeBudgetActivity(row("EventBudget", "CLOSE", { actualTotal: "98000.5000", recordedAttendance: 240, notesWritten: 3 }), ctx))
      .toEqual({ title: "Closed", detail: "actual 98,000.50, 240 attended, 3 variance notes" });
    expect(describeBudgetActivity(row("EventBudget", "SIGN_OFF"), ctx)).toEqual({ title: "Signed off", detail: null });
    expect(describeBudgetActivity(row("EventBudget", "REOPEN", { reason: "Missed invoice" }), ctx)).toEqual({ title: "Reopened", detail: "reason: Missed invoice" });
    expect(describeBudgetActivity(row("EventBudget", "NEW_VERSION", { fromVersionNo: 1, lines: 14 }), ctx)).toEqual({ title: "Created as a new version", detail: "from version 1, 14 lines carried" });
  });
  it("discard distinguishes a withdrawal from a dropped draft", () => {
    expect(describeBudgetActivity(row("EventBudget", "DISCARD", { status: "UNDER_REVIEW", versionNo: 3 }), ctx)).toEqual({ title: "Withdrawn from review", detail: "version 3" });
    expect(describeBudgetActivity(row("EventBudget", "DISCARD", { status: "DRAFT" }), ctx).title).toBe("Draft discarded");
  });
});

describe("describeBudgetActivity: lines and approval routing", () => {
  it("line rows name the line", () => {
    expect(describeBudgetActivity(row("BudgetLine", "CREATE", { description: "Coffee breaks", planned: "1200.0000" }), ctx)).toEqual({ title: "Line added: Coffee breaks", detail: "planned 1,200.00" });
    expect(describeBudgetActivity(row("BudgetLine", "CREATE", { description: "Audio Video Equipment Rental", planned: "8000", productSku: "510301" }), ctx).detail).toBe("planned 8,000.00, SKU 510301");
    expect(describeBudgetActivity(row("BudgetLine", "UPDATE", { description: "Coffee breaks", planned: "1500", touchesPlanned: true }), ctx).detail).toBe("planned now 1,500.00");
    expect(describeBudgetActivity(row("BudgetLine", "UPDATE", { description: "Coffee breaks", touchesPlanned: false }), ctx).detail).toBe("details or forecast");
    expect(describeBudgetActivity(row("BudgetLine", "DELETE", { description: "Coffee breaks" }), ctx)).toEqual({ title: "Line removed: Coffee breaks", detail: null });
  });
  it("routing names the assignee when the org resolved the id", () => {
    expect(describeBudgetActivity(row("ApprovalRequest", "APPROVAL_REQUESTED", { assigneeUserId: "u2", amountAed: 125000, superseded: ["r0"] }), ctx))
      .toEqual({ title: "Routed to Muthu for approval", detail: "AED 125,000.00, replacing an earlier request" });
    expect(describeBudgetActivity(row("ApprovalRequest", "APPROVAL_REQUESTED", { assigneeUserId: "unknown", amountAed: 10 }), ctx).title).toBe("Routed for approval");
    expect(describeBudgetActivity(row("ApprovalRequest", "APPROVAL_CANCELLED", {}), ctx)).toEqual({ title: "Approval request cancelled", detail: null });
  });
  it("an action nobody taught it still reads as words", () => {
    expect(describeBudgetActivity(row("EventBudget", "SOME_NEW_THING"), ctx)).toEqual({ title: "some new thing", detail: null });
    expect(describeBudgetActivity(row("Elsewhere", "PING"), ctx).title).toBe("ping");
  });
  it("never writes an em dash into a sentence", () => {
    const all = [
      row("EventBudget", "CREATE", { templateId: "t", seededLines: 2, reportingCurrency: "USD" }),
      row("EventBudget", "REALLOCATE", { fromLineKey: "venue", toLineKey: "av", amount: "1", authority: "OWNER", reason: "r" }),
      row("EventBudget", "CLOSE", { actualTotal: "1", recordedAttendance: 1, notesWritten: 1 }),
      row("ApprovalRequest", "APPROVAL_REQUESTED", { assigneeUserId: "u2", amountAed: 1, superseded: ["x"] }),
    ];
    for (const r of all) {
      const d = describeBudgetActivity(r, ctx);
      expect(`${d.title} ${d.detail ?? ""}`).not.toMatch(/\u2014/);
    }
  });
});
