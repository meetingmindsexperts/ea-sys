import { NextResponse } from "next/server";
import { canViewFinance } from "@/lib/finance-visibility";

/**
 * Returns a 403 Forbidden response if the user has a restricted role
 * (REVIEWER, SUBMITTER, REGISTRANT, or MEMBER).
 * These roles are only allowed limited operations — all other
 * write operations (POST, PUT, DELETE) on non-abstract resources must
 * call this guard before proceeding.
 *
 * Usage:
 *   const denied = denyReviewer(session);
 *   if (denied) return denied;
 */
export function denyReviewer(session: { user?: { role?: string } } | null) {
  const role = session?.user?.role;
  if (role === "REVIEWER" || role === "SUBMITTER" || role === "REGISTRANT" || role === "MEMBER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * Returns a 403 if the session's role cannot view financial data.
 * `denyReviewer` covers write routes; this covers finance-data GET
 * routes (invoice list/detail/PDF/send, quote + document PDFs) which
 * are reads — denyReviewer would let MEMBER through since GETs aren't
 * blocked there. MEMBER is the org-bound read-only viewer that is
 * specifically barred from money.
 *
 * Usage (after auth + event-access check):
 *   const noFinance = denyFinance(session);
 *   if (noFinance) return noFinance;
 */
export function denyFinance(session: { user?: { role?: string } } | null) {
  if (!canViewFinance(session?.user?.role)) {
    return NextResponse.json(
      { error: "Financial data is not available to your role", code: "FINANCE_FORBIDDEN" },
      { status: 403 },
    );
  }
  return null;
}
