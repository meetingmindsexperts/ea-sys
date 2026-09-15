import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { isHrModuleEnabled, isProcurementModuleEnabled } from "@/lib/module-flags";
import { canViewHr, HR_AUDIT_ENTITY_TYPES } from "@/lib/hr-visibility";
import { canViewProcurement, PROCUREMENT_AUDIT_ENTITY_TYPES } from "@/lib/procurement-visibility";
import { describeProcurementActivity, type DescribeContext } from "@/lib/procurement-activity";
import type { Prisma } from "@prisma/client";

/**
 * THREE SCOPES OVER ONE TABLE (HR split Sep 3, 2026; procurement split Sep 15).
 *
 * The HR module writes its audit rows into the same `AuditLog` the events
 * business does, stamped with the org like every other row. This route is
 * gated to ADMIN + SUPER_ADMIN; HR is gated to SUPER_ADMIN plus the per-person
 * `hrAccess` grant, and ADMIN alone is deliberately NOT enough (owner, Aug 31).
 * Until this split, an admin with no grant saw "Employee created, <name>" in
 * the Changes feed and the raw JSON handed them every attendance blob
 * (employee id, leave code, date range). So:
 *
 *   - default scope EXCLUDES the HR entity types, always, even when the caller
 *     names one of them in `entityType` (the filter narrows within the
 *     exclusion, it cannot lift it);
 *   - `?scope=hr` INCLUDES only them, behind the same two walls the HR routes
 *     use: module switched on (else 404, a module that is not here should not
 *     announce itself) and `canViewHr` (else 403).
 *
 * The Budget & Procurement module (Sep 15, 2026, owner: "keep budget activity
 * separate from event activity") is the same shape one module over: its rows
 * are excluded from the default scope and served by `?scope=procurement`
 * behind the module flag and `canViewProcurement`. Here the point is less a
 * boundary (every reader of this page may read budgets) than legibility:
 * money movements between two hundred registration edits are noise on both
 * sides, and a budget row names its subject by id, so this route resolves the
 * labels ("HM2026 v2", "PR-2026-0004 · LED wall") once per page, org-bound,
 * inside the lane, and runs the module's describer server-side so the client
 * renders words.
 *
 * Both sets are pinned to their writers by source-level tests, so a new table
 * in either module cannot quietly land back in the general feed.
 */
const HR_TYPES = [...HR_AUDIT_ENTITY_TYPES];
const PROCUREMENT_TYPES = [...PROCUREMENT_AUDIT_ENTITY_TYPES];
const EXCLUDED_FROM_CHANGES = [...HR_TYPES, ...PROCUREMENT_TYPES];

type Scope = "changes" | "hr" | "procurement";

function parseScope(raw: string | null): Scope | null {
  if (raw === null || raw === "changes") return "changes";
  if (raw === "hr" || raw === "procurement") return raw;
  return null;
}

type AuditRow = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  changes: Prisma.JsonValue;
  createdAt: Date;
  user: { firstName: string; lastName: string; email: string } | null;
  event: { id: string; name: string } | null;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function displayName(u: { firstName: string; lastName: string; email: string }): string {
  return `${u.firstName} ${u.lastName}`.trim() || u.email;
}

/**
 * HR rows name their subject by id only (an `Employee` row's entityId, an
 * attendance row's `employee:<id>`, a rule's `changes.employeeId`), and the
 * blobs deliberately carry codes and dates rather than names. Resolve the
 * names ONCE here, org-bound, inside the same lane, so the feed can say who a
 * row is about without a second request per row.
 */
async function attachHrSubjects(rows: AuditRow[], orgId: string) {
  const employeeIds = new Set<string>();
  const idOf = (r: AuditRow): string | null => {
    if (r.entityType === "Employee") return r.entityId;
    if (r.entityId.startsWith("employee:")) return r.entityId.slice("employee:".length);
    const c = asRecord(r.changes);
    return typeof c.employeeId === "string" ? c.employeeId : null;
  };
  for (const r of rows) {
    const id = idOf(r);
    if (id) employeeIds.add(id);
  }
  const names = new Map<string, string>();
  if (employeeIds.size > 0) {
    const employees = await db.employee.findMany({
      where: { id: { in: [...employeeIds] }, organizationId: orgId },
      select: { id: true, name: true, empCode: true },
    });
    for (const e of employees) names.set(e.id, e.name);
  }
  return rows.map((r) => {
    const id = idOf(r);
    return { ...r, subjectName: id ? (names.get(id) ?? null) : null };
  });
}

/**
 * Procurement rows name their subject by id: a budget by its row id (or by
 * `changes.budgetId` on a line, a request or an order), a request by its row
 * id or by an approval's `subjectId`, a supplier, product, category or
 * template by its row id. One `findMany` per family, org-bound, only for the
 * families the page actually carries; the payload's own numbers (`requestNo`,
 * `commitmentNo`, an export's `eventCode`) are the fallback when a row is
 * gone, so a label is never lost with its record.
 */
async function attachProcurementSubjects(rows: AuditRow[], orgId: string) {
  const budgetIds = new Set<string>();
  const requestIds = new Set<string>();
  const commitmentIds = new Set<string>();
  const supplierIds = new Set<string>();
  const productIds = new Set<string>();
  const categoryIds = new Set<string>();
  const templateIds = new Set<string>();
  const userIds = new Set<string>();
  const lineKeys = new Set<string>();

  for (const r of rows) {
    const c = asRecord(r.changes);
    const budgetId = strOf(c.budgetId) ?? strOf(asRecord(c.filters).budgetId);
    if (budgetId) budgetIds.add(budgetId);
    for (const k of ["fromLineKey", "toLineKey"]) {
      const key = strOf(c[k]);
      if (key) lineKeys.add(key);
    }
    for (const k of ["assigneeUserId", "receivedByUserId", "fromUserId", "toUserId"]) {
      const id = strOf(c[k]);
      if (id) userIds.add(id);
    }
    switch (r.entityType) {
      case "EventBudget":
        if (r.action !== "EXPORT") budgetIds.add(r.entityId);
        break;
      case "SpendRequest":
        requestIds.add(r.entityId);
        break;
      case "Commitment":
        commitmentIds.add(r.entityId);
        break;
      case "Supplier":
        if (r.action !== "IMPORT") supplierIds.add(r.entityId);
        break;
      case "BudgetProduct":
        if (r.action !== "IMPORT") productIds.add(r.entityId);
        break;
      case "BudgetCategory":
        categoryIds.add(r.entityId);
        break;
      case "BudgetTemplate":
        templateIds.add(r.entityId);
        break;
      case "ApprovalRequest": {
        const subjectId = strOf(c.subjectId);
        if (!subjectId) break;
        if (c.subjectType === "SPEND_REQUEST") requestIds.add(subjectId);
        else budgetIds.add(subjectId);
        break;
      }
    }
  }

  const org = orgId;
  const [budgets, requests, commitments, suppliers, products, categories, templates, users, lines] = await Promise.all([
    budgetIds.size ? db.eventBudget.findMany({ where: { id: { in: [...budgetIds] }, organizationId: org }, select: { id: true, eventCode: true, versionNo: true } }) : [],
    requestIds.size ? db.spendRequest.findMany({ where: { id: { in: [...requestIds] }, organizationId: org }, select: { id: true, requestNo: true, title: true } }) : [],
    commitmentIds.size ? db.commitment.findMany({ where: { id: { in: [...commitmentIds] }, organizationId: org }, select: { id: true, commitmentNo: true, spendRequest: { select: { title: true } } } }) : [],
    supplierIds.size ? db.supplier.findMany({ where: { id: { in: [...supplierIds] }, organizationId: org }, select: { id: true, displayName: true } }) : [],
    productIds.size ? db.budgetProduct.findMany({ where: { id: { in: [...productIds] }, organizationId: org }, select: { id: true, name: true } }) : [],
    categoryIds.size ? db.budgetCategory.findMany({ where: { id: { in: [...categoryIds] }, organizationId: org }, select: { id: true, name: true } }) : [],
    templateIds.size ? db.budgetTemplate.findMany({ where: { id: { in: [...templateIds] }, organizationId: org }, select: { id: true, name: true } }) : [],
    userIds.size ? db.user.findMany({ where: { id: { in: [...userIds] }, organizationId: org }, select: { id: true, firstName: true, lastName: true, email: true } }) : [],
    lineKeys.size ? db.budgetLine.findMany({ where: { lineKey: { in: [...lineKeys] }, organizationId: org }, select: { lineKey: true, description: true } }) : [],
  ]);

  const budgetLabel = new Map(budgets.map((b) => [b.id, `${b.eventCode} v${b.versionNo}`]));
  const requestLabel = new Map(requests.map((r) => [r.id, `${r.requestNo} · ${r.title}`]));
  const commitmentLabel = new Map(commitments.map((c) => [c.id, c.spendRequest?.title ? `${c.commitmentNo} · ${c.spendRequest.title}` : c.commitmentNo]));
  const supplierLabel = new Map(suppliers.map((s) => [s.id, s.displayName]));
  const productLabel = new Map(products.map((p) => [p.id, p.name]));
  const categoryLabel = new Map(categories.map((c) => [c.id, c.name]));
  const templateLabel = new Map(templates.map((t) => [t.id, t.name]));

  const ctx: DescribeContext = {
    // A line removed since the move still has its name on its own DELETE row
    // in this page; a line older than the page reads as its key. The
    // per-budget card, which sits on one budget, resolves them all.
    lineNames: Object.fromEntries(lines.map((l) => [l.lineKey, l.description])),
    userNames: Object.fromEntries(users.map((u) => [u.id, displayName(u)])),
  };

  const subjectOf = (r: AuditRow): string | null => {
    const c = asRecord(r.changes);
    const viaBudget = (id: string | null) => (id ? (budgetLabel.get(id) ?? null) : null);
    switch (r.entityType) {
      case "EventBudget": {
        if (r.action !== "EXPORT") return viaBudget(r.entityId);
        const f = asRecord(c.filters);
        const fromRow = viaBudget(strOf(f.budgetId));
        if (fromRow) return fromRow;
        const code = strOf(f.eventCode);
        return code ? (typeof f.versionNo === "number" ? `${code} v${f.versionNo}` : code) : null;
      }
      case "BudgetLine":
        return viaBudget(strOf(c.budgetId));
      case "SpendRequest":
        return requestLabel.get(r.entityId) ?? strOf(c.requestNo);
      case "Commitment":
        return commitmentLabel.get(r.entityId) ?? strOf(c.commitmentNo);
      case "Supplier":
        return supplierLabel.get(r.entityId) ?? strOf(c.displayName) ?? strOf(c.code);
      case "BudgetProduct":
        return productLabel.get(r.entityId) ?? strOf(c.name) ?? strOf(c.sku);
      case "BudgetCategory":
        return categoryLabel.get(r.entityId) ?? strOf(c.name) ?? strOf(c.code);
      case "BudgetTemplate":
        return templateLabel.get(r.entityId) ?? strOf(c.name);
      case "ApprovalRequest": {
        const subjectId = strOf(c.subjectId);
        if (!subjectId) return null;
        if (c.subjectType === "SPEND_REQUEST") return requestLabel.get(subjectId) ?? null;
        const label = viaBudget(subjectId);
        return label && c.subjectType === "BUDGET_REALLOCATION" ? `${label} (move between lines)` : label;
      }
      default:
        return null;
    }
  };

  return rows.map((r) => {
    const described = describeProcurementActivity(
      { id: r.id, at: r.createdAt.toISOString(), entityType: r.entityType, action: r.action, changes: asRecord(r.changes), actor: null },
      ctx,
    );
    return { ...r, subjectName: subjectOf(r), title: described.title, detail: described.detail };
  });
}

export async function GET(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only SUPER_ADMIN and ADMIN can view global activity
    const allowedRoles = ["SUPER_ADMIN", "ADMIN"];
    if (!allowedRoles.includes(session.user.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(req.url);

    const scopeParam = url.searchParams.get("scope");
    const scope = parseScope(scopeParam);
    if (scope === null) {
      // A bad scope must never fall through to the default and silently widen
      // (the same rule the bulk-email filters follow).
      apiLogger.warn({ msg: "activity:invalid-scope", scope: scopeParam, userId: session.user.id });
      return NextResponse.json({ error: "Invalid scope", code: "INVALID_SCOPE" }, { status: 400 });
    }
    const hrScope = scope === "hr";
    const procurementScope = scope === "procurement";

    if (hrScope && !isHrModuleEnabled()) {
      apiLogger.warn({ msg: "activity:hr-module-disabled", userId: session.user.id });
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (hrScope && !canViewHr(session.user)) {
      apiLogger.warn({
        msg: "activity:hr-scope-forbidden",
        role: session.user.role,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // The same two walls for the procurement scope. Every role this page
    // admits may read budgets today, so the 403 is reachable only if the page
    // gate is widened; it stays because the predicate, not the page, is the
    // control (fail closed).
    if (procurementScope && !isProcurementModuleEnabled()) {
      apiLogger.warn({ msg: "activity:procurement-module-disabled", userId: session.user.id });
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (procurementScope && !canViewProcurement(session.user)) {
      apiLogger.warn({
        msg: "activity:procurement-scope-forbidden",
        role: session.user.role,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Ceiling raised 100 → 500 so the feed's "Load more" has somewhere to go.
    // Deliberately a growing `take` rather than a cursor: the audit feed is
    // admin-only, low-traffic, and a single ordered read of ≤500 rows on an
    // indexed createdAt is cheaper than the complexity of keeping a cursor in
    // sync with the 30s auto-refresh (which must always re-anchor at "now").
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit")) || 50, 1),
      500
    );

    // Filters
    const eventId = url.searchParams.get("eventId") || undefined;
    const userId = url.searchParams.get("userId") || undefined;
    const action = url.searchParams.get("action") || undefined;
    const entityType = url.searchParams.get("entityType") || undefined;
    const timeRange = url.searchParams.get("timeRange") || undefined;

    const orgId = session.user.organizationId!;

    // Flat tenant predicate (Domain #19, Aug 3 2026): AuditLog now carries a
    // denormalized `organizationId` — backfilled for the whole history and
    // stamped centrally on every new write (withAuditOrgStamp in db.ts) — so
    // this replaces the old dual-shape OR (`event: { organizationId }` +
    // `changes.organizationId` JSON match). The flat column is a strict
    // SUPERSET of both legs, and it makes previously-invisible rows appear:
    // Contact audits, the CRM config helpers, and org-admin user audits
    // carried no org marker anywhere and never showed in this feed before.
    // Backed by @@index([organizationId, createdAt]).
    const where: Prisma.AuditLogWhereInput = { organizationId: orgId };

    // The scope decides the entityType predicate; an explicit filter narrows
    // WITHIN it. `{ equals: "Employee", notIn: [...] }` yields zero rows in
    // the default scope, which is the point: the filter cannot smuggle an HR
    // or a budget row past the exclusion.
    const entityTypeFilter: Prisma.StringFilter = hrScope
      ? { in: HR_TYPES }
      : procurementScope
        ? { in: PROCUREMENT_TYPES }
        : { notIn: EXCLUDED_FROM_CHANGES };
    if (entityType) entityTypeFilter.equals = entityType;
    where.entityType = entityTypeFilter;

    if (eventId) {
      // An explicit event filter narrows within the org (the org predicate
      // stays — a foreign eventId yields zero rows, not a leak).
      where.eventId = eventId;
    }
    if (userId) {
      where.userId = userId;
    }
    if (action) {
      where.action = action;
    }
    if (timeRange) {
      const now = new Date();
      let since: Date | undefined;
      switch (timeRange) {
        case "1h": since = new Date(now.getTime() - 60 * 60 * 1000); break;
        case "24h": since = new Date(now.getTime() - 24 * 60 * 60 * 1000); break;
        case "7d": since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
        case "30d": since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
      }
      if (since) {
        where.createdAt = { gte: since };
      }
    }

    // Session-org tenant lane (inert on master; the platform's RLS backstop).
    const logs = await runWithTenant(orgId, async () => {
      const rows: AuditRow[] = await db.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          changes: true,
          createdAt: true,
          user: {
            select: { firstName: true, lastName: true, email: true },
          },
          event: {
            select: { id: true, name: true },
          },
        },
      });
      if (hrScope) return attachHrSubjects(rows, orgId);
      if (procurementScope) return attachProcurementSubjects(rows, orgId);
      return rows;
    });

    return NextResponse.json(logs);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to fetch global activity" });
    return NextResponse.json(
      { error: "Failed to fetch activity" },
      { status: 500 }
    );
  }
}
