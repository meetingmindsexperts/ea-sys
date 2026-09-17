/**
 * The procurement activity describer: ONE function that turns the module's
 * AuditLog rows into a sentence a finance reader understands ("Amount moved
 * between lines", "Routed to Muthu for approval", "Order emailed to the
 * supplier"). Pure and client-safe (no db, no Node imports).
 *
 * WHY IT LIVES IN CORE (moved from `src/procurement/lib/budget-activity.ts`
 * on Sep 15, 2026). The per-budget activity card inside the module was its
 * first reader. The org Activity page's Budget tab is the second, and that
 * page is core: the eslint boundary forbids core importing the module, so the
 * describer moved here and the module keeps a re-export shim (the
 * `hr-visibility` precedent). Two readers, one describer, one set of words.
 *
 * The payloads it reads are the ones the module's services and the approvals
 * primitive write (`changes` on the AuditLog row); anything it does not
 * recognise falls back to the action name in words, never to nothing. The
 * unit tests pin every action's wording, so a renamed audit action shows up as
 * a failing test rather than as a raw "REALLOCATION_REQUESTED" on screen.
 *
 * Numbers (a request's PR number, an order's PO number) are deliberately NOT
 * put into the title: the reader that shows several subjects at once (the
 * Budget tab) resolves the subject label server-side and prints it beside the
 * title, and a reader that already sits on one subject (the budget page) has
 * no need of it.
 */
import { waitedPhrase } from "@/lib/approvals/approval-emails";

export interface ProcurementActivityRow {
  id: string;
  /** ISO instant. */
  at: string;
  entityType: string;
  action: string;
  changes: Record<string, unknown>;
  actor: { name: string | null; email: string | null } | null;
}

export interface ProcurementActivityItem extends ProcurementActivityRow {
  title: string;
  detail: string | null;
}

export interface DescribeContext {
  /** lineKey -> description, from the budget's lines, deleted ones included. */
  lineNames: Record<string, string>;
  /** userId -> display name, for the ids a payload carries (the assignee, the receiver). */
  userNames: Record<string, string>;
}

export const EMPTY_DESCRIBE_CONTEXT: DescribeContext = { lineNames: {}, userNames: {} };

const FIELD_LABELS: Record<string, string> = {
  notes: "notes",
  contingencyPercent: "contingency percent",
  reportingCurrency: "reporting currency",
  expectedAttendance: "expected attendance",
  brand: "brand",
  naCategoryCodes: "categories marked not applicable",
  financeOwnerUserId: "finance owner",
  benchmarkSourceType: "benchmark source",
  benchmarkSourceId: "benchmark",
  neededBy: "needed by",
  sourcingMethod: "sourcing",
  supplierId: "supplier",
  proposedVendorName: "proposed vendor",
  taxRegistrationNo: "tax registration number",
  bankDetails: "bank details",
  paymentTerms: "payment terms",
  legalName: "legal name",
  displayName: "display name",
  categoryId: "category",
  unitPrice: "unit price",
  isActive: "active",
};

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function fieldLabel(f: string): string {
  return FIELD_LABELS[f] ?? humanize(f);
}

function fieldList(v: unknown): string | null {
  const fields = Array.isArray(v) ? v.filter((f): f is string => typeof f === "string").map(fieldLabel) : [];
  return fields.length ? fields.join(", ") : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 4dp stored strings become 2dp display; anything unreadable is dropped. */
function amount(v: unknown): string | null {
  const n = num(v);
  return n === null ? null : n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "AED 5,000.00" when both halves are readable, the bare amount when only the amount is. */
function money(currency: unknown, v: unknown): string | null {
  const a = amount(v);
  if (!a) return null;
  const cur = str(currency);
  return cur ? `${cur.toUpperCase()} ${a}` : a;
}

function count(n: number | null, singular: string, plural = `${singular}s`): string | null {
  return n === null ? null : `${n} ${n === 1 ? singular : plural}`;
}

function parts(...items: (string | null | undefined)[]): string | null {
  const kept = items.filter((p): p is string => !!p);
  return kept.length ? kept.join(", ") : null;
}

function lineName(ctx: DescribeContext, key: string | null): string {
  if (!key) return "a line";
  return ctx.lineNames[key] || key;
}

function moveSentence(c: Record<string, unknown>, ctx: DescribeContext): string | null {
  const a = amount(c.amount);
  if (!a) return null;
  return `${a} from ${lineName(ctx, str(c.fromLineKey))} to ${lineName(ctx, str(c.toLineKey))}`;
}

function withLabel(label: string, v: string | null): string | null {
  return v ? `${label}: ${v}` : null;
}

/** The budget check a submission or an amendment ran, in words. */
function budgetCheckWord(v: unknown): string | null {
  switch (v) {
    case "WITHIN_BUDGET":
      return "within budget";
    case "OVER_BUDGET":
      return "over budget";
    case "FROZEN":
      return "budget frozen";
    default:
      return null;
  }
}

function amountChange(c: Record<string, unknown>): string | null {
  const from = amount(c.previousAmount);
  const to = amount(c.nextAmount);
  if (!from || !to) return null;
  return `${from} to ${to}`;
}

/** What a transfer row's entity type is called, for the export and import sentences. */
const TRANSFER_NOUNS: Record<string, { one: string; many: string }> = {
  EventBudget: { one: "Budget", many: "Budgets" },
  BudgetProduct: { one: "Product", many: "Products" },
  Supplier: { one: "Supplier", many: "Suppliers" },
  BudgetTemplate: { one: "Template", many: "Templates" },
  BudgetCategory: { one: "Category", many: "Categories" },
  SpendRequest: { one: "Request", many: "Requests" },
  Commitment: { one: "Order", many: "Orders" },
};

/**
 * EXPORT and IMPORT rows are written by the shared `recordExport` /
 * `recordImport` helpers, so their payload has one shape whatever the entity
 * type: row counts and a format, filters for an export. Handled before the
 * per-family switches because every family can be exported.
 */
function describeTransfer(row: ProcurementActivityRow): { title: string; detail: string | null } | null {
  const c = row.changes ?? {};
  const noun = TRANSFER_NOUNS[row.entityType] ?? { one: humanize(row.entityType), many: humanize(row.entityType) };
  const format = str(c.format) ? str(c.format)!.toUpperCase() : null;
  if (row.action === "EXPORT") {
    // A budget export is one budget's lines, so the singular; a catalogue export would be many.
    const single = row.entityType === "EventBudget";
    return { title: `${single ? noun.one : noun.many} exported`, detail: parts(count(num(c.rowCount), "row"), format) };
  }
  if (row.action === "IMPORT") {
    return {
      title: `${noun.many} imported`,
      detail: parts(
        num(c.created) !== null ? `${num(c.created)} created` : null,
        num(c.updated) !== null ? `${num(c.updated)} updated` : null,
        num(c.skipped) !== null ? `${num(c.skipped)} skipped` : null,
        num(c.errors) ? `${num(c.errors)} ${num(c.errors) === 1 ? "error" : "errors"}` : null,
        format,
      ),
    };
  }
  return null;
}

function describeEventBudget(row: ProcurementActivityRow, ctx: DescribeContext): { title: string; detail: string | null } {
  const c = row.changes ?? {};
  const note = withLabel("note", str(c.note));
  const reason = withLabel("reason", str(c.reason));
  switch (row.action) {
    case "CREATE": {
      const seeded = num(c.seededLines);
      return {
        title: "Budget created",
        detail: parts(
          str(c.templateId) ? "seeded from a template" : "started empty",
          seeded ? `${seeded} ${seeded === 1 ? "line" : "lines"}` : null,
          str(c.reportingCurrency) ? `reporting in ${str(c.reportingCurrency)}` : null,
        ),
      };
    }
    case "UPDATE":
      return { title: "Details edited", detail: fieldList(c.fields) };
    case "SUBMIT": {
      // The rate is worth a word only when a conversion happened (an AED budget submits at 1).
      const rate = num(c.reportingToAedRate);
      return { title: "Submitted for approval", detail: parts(amount(c.amountAed) ? `AED ${amount(c.amountAed)}` : null, rate !== null && rate !== 1 ? `rate ${rate} to AED` : null) };
    }
    case "APPROVE": {
      const v = num(c.versionNo);
      return { title: "Approved", detail: parts(v ? `version ${v} is now active` : null, note) };
    }
    case "REJECT":
      return { title: "Rejected, back to draft", detail: note };
    case "NEW_VERSION": {
      const from = num(c.fromVersionNo);
      const lines = num(c.lines);
      return { title: "Created as a new version", detail: parts(from ? `from version ${from}` : null, lines ? `${lines} ${lines === 1 ? "line" : "lines"} carried` : null) };
    }
    case "REALLOCATE": {
      const how = c.authority === "OWNER" ? "within the owner's ten percent" : str(c.approvalRequestId) ? "an approved move" : null;
      return { title: "Amount moved between lines", detail: parts(moveSentence(c, ctx), how, reason, note) };
    }
    case "REALLOCATION_REQUESTED":
      return { title: "Move sent for approval", detail: parts(moveSentence(c, ctx), reason) };
    case "REALLOCATION_REJECTED":
      return { title: "Move rejected", detail: parts(moveSentence(c, ctx), note) };
    case "FREEZE":
      return { title: "Frozen", detail: null };
    case "UNFREEZE":
      return { title: "Unfrozen", detail: reason };
    case "CLOSE": {
      const attended = num(c.recordedAttendance);
      const notes = num(c.notesWritten);
      return {
        title: "Closed",
        detail: parts(
          amount(c.actualTotal) ? `actual ${amount(c.actualTotal)}` : null,
          attended !== null ? `${attended} attended` : null,
          notes ? `${notes} variance ${notes === 1 ? "note" : "notes"}` : null,
        ),
      };
    }
    case "SIGN_OFF":
      return { title: "Signed off", detail: null };
    case "REOPEN":
      return { title: "Reopened", detail: reason };
    case "DISCARD": {
      const v = num(c.versionNo);
      return { title: c.status === "UNDER_REVIEW" ? "Withdrawn from review" : "Draft discarded", detail: v ? `version ${v}` : null };
    }
    default:
      return { title: humanize(row.action), detail: null };
  }
}

function describeBudgetLine(row: ProcurementActivityRow): { title: string; detail: string | null } {
  const c = row.changes ?? {};
  const name = str(c.description) ?? "a line";
  const sku = str(c.productSku) ? `SKU ${str(c.productSku)}` : null;
  switch (row.action) {
    case "CREATE":
      return { title: `Line added: ${name}`, detail: parts(amount(c.planned) ? `planned ${amount(c.planned)}` : null, sku) };
    case "UPDATE":
      return { title: `Line edited: ${name}`, detail: parts(c.touchesPlanned === true && amount(c.planned) ? `planned now ${amount(c.planned)}` : "details or forecast", sku) };
    case "DELETE":
      return { title: `Line removed: ${name}`, detail: null };
    default:
      return { title: `${humanize(row.action)}: ${name}`, detail: null };
  }
}

function describeBudgetRevenueLine(row: ProcurementActivityRow): { title: string; detail: string | null } {
  const c = row.changes ?? {};
  const name = str(c.description) ?? "a revenue line";
  const planned = amount(c.planned) ? `planned ${amount(c.planned)}` : null;
  switch (row.action) {
    case "CREATE":
      return { title: `Revenue line added: ${name}`, detail: planned };
    case "UPDATE":
      return { title: `Revenue line edited: ${name}`, detail: planned ? `${planned.replace("planned", "planned now")}` : null };
    case "DELETE":
      return { title: `Revenue line removed: ${name}`, detail: null };
    default:
      return { title: `${humanize(row.action)}: ${name}`, detail: null };
  }
}

function describeApprovalRequest(row: ProcurementActivityRow, ctx: DescribeContext): { title: string; detail: string | null } {
  const c = row.changes ?? {};
  const aed = amount(c.amountAed) ? `AED ${amount(c.amountAed)}` : null;
  const note = withLabel("note", str(c.note));
  switch (row.action) {
    case "APPROVAL_REQUESTED": {
      const assignee = str(c.assigneeUserId);
      const who = assignee ? ctx.userNames[assignee] ?? null : null;
      const replaced = Array.isArray(c.superseded) && c.superseded.length > 0 ? "replacing an earlier request" : null;
      const final = c.requireFinalApprover === true ? "final approver only" : null;
      return { title: who ? `Routed to ${who} for approval` : "Routed for approval", detail: parts(aed, final, replaced) };
    }
    case "APPROVAL_GRANTED":
      return { title: "Approval granted", detail: parts(aed, note) };
    case "APPROVAL_REJECTED":
      return { title: "Approval refused", detail: parts(aed, note) };
    case "APPROVAL_CANCELLED":
      return { title: "Approval request cancelled", detail: null };
    case "APPROVAL_DELEGATED": {
      // Written by the approval-escalation job at 48 hours (spec §8.3).
      const to = str(c.toUserId);
      const from = str(c.fromUserId);
      const toName = to ? ctx.userNames[to] ?? null : null;
      const fromName = from ? ctx.userNames[from] ?? null : null;
      const hours = num(c.afterHours);
      return {
        title: toName ? `Passed to ${toName} as well` : "Passed to a delegate as well",
        detail: parts(
          hours !== null ? `after ${waitedPhrase(hours)} without a decision` : null,
          fromName ? `${fromName} can still decide it` : null,
          c.via === "configured" ? "chosen as their named delegate" : c.via === "next-tier" ? "chosen from the next tier" : null,
        ),
      };
    }
    case "APPROVAL_ESCALATED": {
      // Written by the approval-escalation job at 96 hours, or at once when the
      // assignee no longer holds the authority to decide.
      const to = str(c.toUserId);
      const from = str(c.fromUserId);
      const toName = to ? ctx.userNames[to] ?? null : null;
      const fromName = from ? ctx.userNames[from] ?? null : null;
      const hours = num(c.afterHours);
      return {
        title: toName ? `Escalated to ${toName}` : "Escalated to the next tier",
        detail:
          c.reason === "assignee-lost-authority"
            ? `${fromName ?? "the approver"} no longer has the authority to decide it`
            : parts(hours !== null ? `after ${waitedPhrase(hours)} without a decision` : null, fromName ? `from ${fromName}` : null),
      };
    }
    default:
      return { title: humanize(row.action), detail: null };
  }
}

function describeSpendRequest(row: ProcurementActivityRow): { title: string; detail: string | null } {
  const c = row.changes ?? {};
  const note = withLabel("note", str(c.note));
  const reason = withLabel("reason", str(c.reason));
  const check = budgetCheckWord(c.budgetCheck);
  switch (row.action) {
    case "CREATE":
      return { title: "Request drafted", detail: money(c.currency, c.amount) };
    case "UPDATE":
      return { title: "Request edited", detail: fieldList(c.fields) };
    case "SUBMIT":
      return {
        title: "Request submitted",
        detail: parts(amount(c.amountAed) ? `AED ${amount(c.amountAed)}` : null, check, c.exception === true ? "to the final approver" : null),
      };
    case "APPROVE":
      return c.landing === "AWAITING_SUPPLIER"
        ? { title: "Request approved, waiting on its supplier", detail: note }
        : { title: "Request approved", detail: note };
    case "REJECT":
      return { title: "Request rejected", detail: note };
    case "AMEND":
      return { title: "Amount reduced", detail: parts(amountChange(c), reason) };
    case "AMENDMENT_REQUESTED":
      return { title: "Amount change sent for approval", detail: parts(amountChange(c), check, reason) };
    case "AMENDMENT_APPROVED":
      return { title: "Amount change approved", detail: parts(amountChange(c), note) };
    case "AMENDMENT_REJECTED":
      return { title: "Amount change rejected", detail: parts(amountChange(c), note) };
    case "WITHDRAW":
      return { title: "Request withdrawn", detail: reason };
    case "CANCEL":
      return { title: "Request cancelled", detail: reason };
    case "QUOTE_ADDED":
      return { title: "Quote added", detail: parts(str(c.vendorName), money(c.currency, c.amount), c.recommended === true ? "recommended" : null) };
    case "QUOTE_REMOVED":
      return { title: "Quote removed", detail: null };
    case "QUOTE_FILE_ATTACHED":
      return { title: "Quote document attached", detail: str(c.fileName) };
    case "QUOTE_FILE_REMOVED":
      return { title: "Quote document removed", detail: null };
    case "CONVERT":
      return { title: "Purchase order issued", detail: str(c.commitmentNo) };
    case "ORDER_CANCELLED":
      return {
        title: c.requestNow === "PENDING_APPROVAL" ? "Purchase order cancelled, request back with the approver" : c.requestNow === "DRAFT" ? "Purchase order cancelled, request back to draft" : "Purchase order cancelled, request back to approved",
        detail: parts(str(c.commitmentNo), reason),
      };
    default:
      return { title: humanize(row.action), detail: null };
  }
}

function describeCommitment(row: ProcurementActivityRow, ctx: DescribeContext): { title: string; detail: string | null } {
  const c = row.changes ?? {};
  const reason = withLabel("reason", str(c.reason));
  switch (row.action) {
    case "CREATE": {
      const tax = num(c.taxAmount);
      return {
        title: "Order issued",
        detail: parts(money(c.currency, c.amount), tax ? `VAT ${amount(c.taxAmount)}` : null, str(c.requestNo) ? `for ${str(c.requestNo)}` : null),
      };
    }
    case "SEND": {
      // The supplier contacts' addresses stay in the row, never in the sentence.
      const n = Array.isArray(c.to) ? c.to.length : null;
      return { title: "Order emailed to the supplier", detail: count(n, "recipient") };
    }
    case "RECEIVE":
      return {
        title: c.extent === "PARTIAL" ? "Marked partly received" : "Marked received",
        detail: c.needsSecondPerson === true ? "a second person must confirm" : null,
      };
    case "CONFIRM_RECEIPT": {
      const receiver = str(c.receivedByUserId);
      const who = receiver ? ctx.userNames[receiver] ?? null : null;
      return { title: "Receipt confirmed", detail: parts(amount(c.amountAed) ? `AED ${amount(c.amountAed)}` : null, who ? `received by ${who}` : null) };
    }
    case "CANCEL":
      return { title: "Order cancelled", detail: parts(amount(c.released) ? `${amount(c.released)} released` : null, reason) };
    default:
      return { title: humanize(row.action), detail: null };
  }
}

function describeSupplier(row: ProcurementActivityRow): { title: string; detail: string | null } {
  const c = row.changes ?? {};
  const code = str(c.code) ? `code ${str(c.code)}` : null;
  const note = withLabel("note", str(c.note));
  switch (row.action) {
    case "CREATE":
      return { title: "Supplier added", detail: parts(code, str(c.currency)) };
    case "PROPOSE":
      return { title: "Supplier proposed", detail: parts(code, str(c.currency)) };
    case "APPROVE":
      return { title: "Supplier approved", detail: parts(code, note) };
    case "REJECT":
      return { title: "Supplier rejected", detail: parts(code, note) };
    case "UPDATE":
      // Field NAMES only: the classified pair (tax number, bank details) is never valued in the row.
      return { title: "Supplier edited", detail: parts(code, fieldList(c.fields)) };
    case "RESTORE":
      return { title: "Supplier restored", detail: code };
    case "DEACTIVATE":
      return { title: "Supplier deactivated", detail: code };
    default:
      return { title: humanize(row.action), detail: null };
  }
}

function describeBudgetProduct(row: ProcurementActivityRow): { title: string; detail: string | null } {
  const c = row.changes ?? {};
  const sku = str(c.sku) ? `SKU ${str(c.sku)}` : null;
  switch (row.action) {
    case "CREATE":
      return { title: "Product added", detail: parts(sku, str(c.categoryCode) ? `category ${str(c.categoryCode)}` : null) };
    case "UPDATE":
      return { title: "Product edited", detail: parts(sku, fieldList(c.fields)) };
    case "RESTORE":
      return { title: "Product restored", detail: sku };
    case "ARCHIVE":
      return { title: "Product archived", detail: sku };
    default:
      return { title: humanize(row.action), detail: null };
  }
}

function describeBudgetCategory(row: ProcurementActivityRow): { title: string; detail: string | null } {
  const c = row.changes ?? {};
  const code = str(c.code) ? `code ${str(c.code)}` : null;
  switch (row.action) {
    case "CREATE":
      return { title: "Category added", detail: code };
    case "RESTORE":
      return { title: "Category restored", detail: code };
    case "ARCHIVE":
      return { title: "Category archived", detail: code };
    case "REALIGN": {
      const created = Array.isArray(c.created) ? c.created.length : 0;
      const removed = Array.isArray(c.removed) ? c.removed.length : 0;
      const moved = typeof c.productsMoved === "number" ? c.productsMoved : 0;
      return { title: "Categories moved to the chart of accounts", detail: `${created} added, ${removed} removed, ${moved} products refiled` };
    }
    default:
      return { title: humanize(row.action), detail: null };
  }
}

function describeBudgetTemplate(row: ProcurementActivityRow): { title: string; detail: string | null } {
  const c = row.changes ?? {};
  switch (row.action) {
    case "CREATE":
      return { title: "Template created", detail: str(c.eventType) ? `for ${humanize(str(c.eventType)!)} events` : null };
    case "UPDATE":
      return { title: "Template edited", detail: fieldList(c.fields) };
    case "ADD_LINE":
      return { title: "Template line added", detail: null };
    case "UPDATE_LINE":
      return { title: "Template line edited", detail: null };
    case "REMOVE_LINE":
      return { title: "Template line removed", detail: null };
    default:
      return { title: humanize(row.action), detail: null };
  }
}

export function describeProcurementActivity(row: ProcurementActivityRow, ctx: DescribeContext = EMPTY_DESCRIBE_CONTEXT): { title: string; detail: string | null } {
  const transfer = describeTransfer(row);
  if (transfer) return transfer;
  switch (row.entityType) {
    case "EventBudget":
      return describeEventBudget(row, ctx);
    case "BudgetLine":
      return describeBudgetLine(row);
    case "BudgetRevenueLine":
      return describeBudgetRevenueLine(row);
    case "ApprovalRequest":
      return describeApprovalRequest(row, ctx);
    case "SpendRequest":
      return describeSpendRequest(row);
    case "Commitment":
      return describeCommitment(row, ctx);
    case "Supplier":
      return describeSupplier(row);
    case "BudgetProduct":
      return describeBudgetProduct(row);
    case "BudgetCategory":
      return describeBudgetCategory(row);
    case "BudgetTemplate":
      return describeBudgetTemplate(row);
    default:
      return { title: humanize(row.action), detail: null };
  }
}
