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
import { canViewCrm, canOwnDeals } from "@/crm/lib/crm-roles";

// Re-exported so server code has one import site for both predicates and guards.
export { canViewCrm, canOwnDeals, canViewDealValues } from "@/crm/lib/crm-roles";

/**
 * Returns a 403 if the caller may not read the CRM, else null.
 *
 * Usage (after the `getOrgContext` null check):
 *   const denied = denyCrmAccess(ctx);
 *   if (denied) return denied;
 */
export function denyCrmAccess(ctx: {
  role: string | null;
  userId: string | null;
  fromApiKey: boolean;
}) {
  if (canViewCrm(ctx.role, ctx.fromApiKey)) return null;

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
export function denyCrmWrite(ctx: {
  role: string | null;
  userId: string | null;
  fromApiKey: boolean;
}) {
  if (canOwnDeals(ctx.role, ctx.fromApiKey)) return null;

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
