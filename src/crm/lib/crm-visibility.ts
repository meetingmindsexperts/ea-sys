/**
 * CRM HTTP guards — SERVER ONLY.
 *
 * This file imports `next/server` and `apiLogger` (which reaches Node's `fs`), so it
 * MUST NOT be imported by a "use client" component. The pure predicates it wraps live
 * in `crm-roles.ts` and are client-safe; UI code imports those.
 *
 * That split is not tidiness. When the predicates lived here, the sidebar and the
 * deals board imported them, Next pulled `fs` into the client graph, and the build
 * broke. Had it not broken, the runtime symptom would have been a button that does
 * nothing and logs nothing (see AGENTS.md).
 *
 * The guards LOG THEIR OWN REFUSAL, so no call site can forget to — the payments
 * review's M12 lesson. A restricted role probing the sponsorship pipeline is exactly
 * the line you want in /logs.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { can, principalFromUser } from "@/lib/permissions/can";
import type { PermissionKey } from "@/lib/permissions/catalogue";
import { principalFromCaller } from "@/lib/permissions/require-permission";

/**
 * The caller as the CRM routes see it: a session, an API key or a mobile token
 * (`getOrgContext`). `organizationId` is required because every CRM key is
 * organisation-wide.
 */
export interface CrmCaller {
  organizationId: string;
  userId: string | null;
  role: string | null;
  fromApiKey: boolean;
  /** The session's custom-role keys (`getOrgContext` carries them). */
  customGrants?: readonly string[] | null;
}

/**
 * May this caller do `key` in the CRM? The ONE place the CRM asks (custom roles
 * Phase 2, Oct 5, 2026): the guards below and the routes' value, inbox, quote
 * and export checks all come here, so a role editor's grant decides them all.
 * The system grants equal the old role predicates in `crm-roles.ts`, pinned by
 * system-roles-parity.test.ts; the UI still reads those client-safe predicates.
 *
 * A signed-in person is judged with their custom roles (the context carries
 * the session's keys): since Oct 7, 2026 ORGANIZER and MEMBER reach the CRM
 * only through one. An API key or a mobile token keeps its own principal.
 */
export function crmCan(ctx: CrmCaller, key: PermissionKey): boolean {
  const principal =
    !ctx.fromApiKey && ctx.customGrants && ctx.customGrants.length > 0
      ? principalFromUser({ id: ctx.userId, role: ctx.role, organizationId: ctx.organizationId, procurementPermissions: ctx.customGrants })
      : principalFromCaller(null, ctx);
  return principal !== null && can(principal, key);
}


/**
 * Returns a 403 if the caller may not read the CRM, else null.
 *
 * Usage (after the `getOrgContext` null check):
 *   const denied = denyCrmAccess(ctx);
 *   if (denied) return denied;
 */
export function denyCrmAccess(ctx: CrmCaller) {
  if (crmCan(ctx, "crm.read")) return null;

  apiLogger.warn({
    msg: "auth-guard:crm-read-denied",
    role: ctx.role,
    userId: ctx.userId,
  });
  return NextResponse.json(
    { error: "The CRM is not available to your role", code: "CRM_FORBIDDEN" },
    { status: 403 },
  );
}

/**
 * Returns a 403 if the caller may not WRITE to the CRM (own deals, edit companies,
 * complete tasks), else null. MEMBER hits this — it reads the board but never moves
 * a card.
 */
export function denyCrmWrite(ctx: CrmCaller) {
  if (crmCan(ctx, "crm.write")) return null;

  apiLogger.warn({
    msg: "auth-guard:crm-write-denied",
    role: ctx.role,
    userId: ctx.userId,
  });
  return NextResponse.json(
    { error: "You do not have permission to modify CRM records", code: "CRM_WRITE_FORBIDDEN" },
    { status: 403 },
  );
}

/**
 * Returns a 403 if the caller may not ARCHIVE/RESTORE a CRM record, else null.
 *
 * Narrower than denyCrmWrite: ORGANIZER can edit a deal but not archive it. Used by
 * the DELETE handlers and the restore branch of PATCH. Logs its own refusal.
 */
export function denyCrmDelete(ctx: CrmCaller) {
  if (crmCan(ctx, "crm.delete")) return null;

  apiLogger.warn({
    msg: "auth-guard:crm-delete-denied",
    role: ctx.role,
    userId: ctx.userId,
  });
  return NextResponse.json(
    { error: "Only admins and the sales team can archive CRM records", code: "CRM_DELETE_FORBIDDEN" },
    { status: 403 },
  );
}

/**
 * Returns a 403 if the caller may not EXPORT CRM data to CSV, else null.
 *
 * Admin and above (owner decision, August 7 2026) — narrower than BOTH read and
 * write, so a MEMBER, an ORGANIZER and a CRM_USER all read the board but none of
 * them can walk out with the book. Rationale in full on CRM_EXPORT_ROLES.
 * Logs its own refusal.
 */
export function denyCrmExport(ctx: CrmCaller) {
  if (crmCan(ctx, "crm.export")) return null;

  apiLogger.warn({
    msg: "auth-guard:crm-export-denied",
    role: ctx.role,
    userId: ctx.userId,
    fromApiKey: ctx.fromApiKey,
  });
  return NextResponse.json(
    { error: "Only admins can export CRM data", code: "CRM_EXPORT_FORBIDDEN" },
    { status: 403 },
  );
}

/**
 * Returns a 403 if the caller may not change the PRODUCT CATALOGUE (add, edit,
 * archive, restore, link to QuickBooks), else null.
 *
 * Admins only (owner, Nov 12, 2026): the sales team reads the catalogue and
 * puts its products on deals at the price they type, and never changes the
 * catalogue itself. Asked AFTER the write gate by every handler under
 * /api/crm/products (a source test lists them). Archive and restore of a
 * product need this key and not `crm.delete`, which is about deals and accounts.
 * Logs its own refusal.
 */
export function denyCrmProductsManage(ctx: CrmCaller) {
  if (crmCan(ctx, "crm.products.manage")) return null;

  apiLogger.warn({
    msg: "auth-guard:crm-products-manage-denied",
    role: ctx.role,
    userId: ctx.userId,
    fromApiKey: ctx.fromApiKey,
  });
  return NextResponse.json(
    { error: "Only admins can change the product catalogue", code: "CRM_PRODUCTS_FORBIDDEN" },
    { status: 403 },
  );
}

/**
 * Returns a 403 if the caller may not open CRM REPORTS (the pipeline by stage,
 * won and lost, the per-person table, the breakdowns), else null. It hides the
 * summaries, not the deals: the board still shows every deal to everyone in
 * the CRM.
 *
 * Admins only (owner, Nov 12, 2026). CRM Home's two totals are NOT this: they
 * come from /api/crm/reports/headline, which everyone in the CRM may read
 * (owner: "Reports page only"). Logs its own refusal.
 */
export function denyCrmReports(ctx: CrmCaller) {
  if (crmCan(ctx, "crm.reports.view")) return null;

  apiLogger.warn({
    msg: "auth-guard:crm-reports-denied",
    role: ctx.role,
    userId: ctx.userId,
    fromApiKey: ctx.fromApiKey,
  });
  return NextResponse.json(
    { error: "Only admins can open CRM reports", code: "CRM_REPORTS_FORBIDDEN" },
    { status: 403 },
  );
}

/**
 * Returns a 403 if the caller may not PERMANENTLY delete (purge) archived CRM
 * records, else null.
 *
 * SUPER_ADMIN sessions only — narrower than denyCrmDelete, and the one CRM
 * guard that also refuses API keys (destruction is a human decision; a leaked
 * key must not be able to erase revenue history). Logs its own refusal.
 */
export function denyCrmPurge(ctx: CrmCaller) {
  if (crmCan(ctx, "crm.purge")) return null;

  apiLogger.warn({
    msg: "auth-guard:crm-purge-denied",
    role: ctx.role,
    userId: ctx.userId,
    fromApiKey: ctx.fromApiKey,
  });
  return NextResponse.json(
    { error: "Only a super admin can permanently delete archived CRM records", code: "CRM_PURGE_FORBIDDEN" },
    { status: 403 },
  );
}
