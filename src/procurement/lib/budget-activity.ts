/**
 * The budget activity log: ONE describer that turns the module's AuditLog
 * rows into a sentence a finance reader understands ("Amount moved between
 * lines", "Routed to Muthu for approval"). Pure and client-safe (no db, no
 * Node imports): the activity route applies it on the server so the card
 * renders text, and the unit test pins every action's wording, so a renamed
 * audit action shows up as a failing test rather than as a raw
 * "REALLOCATION_REQUESTED" on an organiser's screen.
 *
 * The payloads it reads are the ones budget-service and approvals-service
 * write (`changes` on the AuditLog row); anything it does not recognise falls
 * back to the action name in words, never to nothing.
 */
export interface BudgetActivityRow {
  id: string;
  /** ISO instant. */
  at: string;
  entityType: string;
  action: string;
  changes: Record<string, unknown>;
  actor: { name: string | null; email: string | null } | null;
}

export interface BudgetActivityItem extends BudgetActivityRow {
  title: string;
  detail: string | null;
}

export interface DescribeContext {
  /** lineKey -> description, from the budget's lines, deleted ones included. */
  lineNames: Record<string, string>;
  /** userId -> display name, for the ids a payload carries (the assignee). */
  userNames: Record<string, string>;
}

const FIELD_LABELS: Record<string, string> = {
  notes: "notes",
  contingencyPercent: "contingency percent",
  reportingCurrency: "reporting currency",
  expectedAttendance: "expected attendance",
  brand: "brand",
};

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function fieldLabel(f: string): string {
  return FIELD_LABELS[f] ?? humanize(f);
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

export function describeBudgetActivity(row: BudgetActivityRow, ctx: DescribeContext): { title: string; detail: string | null } {
  const c = row.changes ?? {};
  const note = withLabel("note", str(c.note));
  const reason = withLabel("reason", str(c.reason));

  if (row.entityType === "EventBudget") {
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
      case "UPDATE": {
        const fields = Array.isArray(c.fields) ? c.fields.filter((f): f is string => typeof f === "string").map(fieldLabel) : [];
        return { title: "Details edited", detail: fields.length ? fields.join(", ") : null };
      }
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

  if (row.entityType === "BudgetLine") {
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

  if (row.entityType === "ApprovalRequest") {
    switch (row.action) {
      case "APPROVAL_REQUESTED": {
        const assignee = str(c.assigneeUserId);
        const who = assignee ? ctx.userNames[assignee] ?? null : null;
        const replaced = Array.isArray(c.superseded) && c.superseded.length > 0 ? "replacing an earlier request" : null;
        return { title: who ? `Routed to ${who} for approval` : "Routed for approval", detail: parts(amount(c.amountAed) ? `AED ${amount(c.amountAed)}` : null, replaced) };
      }
      case "APPROVAL_CANCELLED":
        return { title: "Approval request cancelled", detail: null };
      default:
        return { title: humanize(row.action), detail: null };
    }
  }

  return { title: humanize(row.action), detail: null };
}
