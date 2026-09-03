import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { isHrModuleEnabled } from "@/lib/module-flags";
import { canViewHr, HR_AUDIT_ENTITY_TYPES } from "@/lib/hr-visibility";
import type { Prisma } from "@prisma/client";

/**
 * TWO SCOPES OVER ONE TABLE (Sep 3, 2026).
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
 * `HR_AUDIT_ENTITY_TYPES` is pinned to the HR services by a source-level test,
 * so a new HR table cannot quietly land back in the general feed.
 */
const HR_TYPES = [...HR_AUDIT_ENTITY_TYPES];

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
    if (scopeParam !== null && scopeParam !== "hr" && scopeParam !== "changes") {
      // A bad scope must never fall through to the default and silently widen
      // (the same rule the bulk-email filters follow).
      apiLogger.warn({ msg: "activity:invalid-scope", scope: scopeParam, userId: session.user.id });
      return NextResponse.json({ error: "Invalid scope", code: "INVALID_SCOPE" }, { status: 400 });
    }
    const hrScope = scopeParam === "hr";

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
    // WITHIN it. `{ equals: "Employee", notIn: HR_TYPES }` yields zero rows in
    // the default scope, which is the point: the filter cannot smuggle an HR
    // row past the exclusion.
    const entityTypeFilter: Prisma.StringFilter = hrScope
      ? { in: HR_TYPES }
      : { notIn: HR_TYPES };
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
      const rows = await db.auditLog.findMany({
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
      if (!hrScope) return rows;

      // HR rows name their subject by id only (an `Employee` row's entityId,
      // an attendance row's `employee:<id>`, a rule's `changes.employeeId`),
      // and the blobs deliberately carry codes and dates rather than names.
      // Resolve the names ONCE here, org-bound, inside the same lane, so the
      // feed can say who a row is about without a second request per row.
      const employeeIds = new Set<string>();
      for (const r of rows) {
        if (r.entityType === "Employee") employeeIds.add(r.entityId);
        if (r.entityId.startsWith("employee:")) employeeIds.add(r.entityId.slice("employee:".length));
        const c = r.changes as Record<string, unknown> | null;
        if (c && typeof c.employeeId === "string") employeeIds.add(c.employeeId);
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
        const c = r.changes as Record<string, unknown> | null;
        const id =
          r.entityType === "Employee"
            ? r.entityId
            : r.entityId.startsWith("employee:")
              ? r.entityId.slice("employee:".length)
              : c && typeof c.employeeId === "string"
                ? c.employeeId
                : null;
        return { ...r, subjectName: id ? (names.get(id) ?? null) : null };
      });
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
