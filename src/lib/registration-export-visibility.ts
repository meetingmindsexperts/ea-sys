/**
 * Who may pull the registrations list as a FILE.
 *
 * Decision record:
 *   - July 27, 2026 (import/export audit review, HIGH-2): the registrations CSV
 *     export moved server-side so it could be audited. It was placed as a mode
 *     on the list GET — correct, because it inherits the event-access gate and
 *     both redaction layers — but that GET has no write guard (`denyReviewer`
 *     guards the POST), so it authorized on `getOrgContext` alone.
 *
 *     That was tolerable while the "export" was a browser-side reassembly of a
 *     JSON payload. It is not tolerable for a one-click
 *     `Content-Disposition: attachment` spreadsheet. Reachability before this
 *     helper: **MEMBER** (the org-bound read-only viewer — internal staff per the RBAC
 *     docs) could pull the full delegate book *including prices and payer
 *     attribution*, and an **internal-domain REGISTRANT** — org-bound since the
 *     June 16 rule, but still role REGISTRANT — could pull every attendee's
 *     name, email, phone, organization, bio, specialty and dietary
 *     requirements for any event they merely signed up for.
 *
 *     For calibration: `/api/contacts/export` is gated by `denyContactExport`
 *     AND rate-limited 10/hr/org. Without this predicate the registrations
 *     export — a strictly larger and more sensitive dataset — was the least
 *     guarded bulk-PII export in the product.
 *
 * WHY ITS OWN BOUNDARY (the recurring lesson in this codebase — reaching for a
 * "close enough" existing predicate is the signal to write a new one):
 *   - `canViewFinance` includes MEMBER → would grant the exact role we're
 *     excluding, and it answers a different question (may you see money).
 *   - `canViewEntryBarcode` happens to have the right role set today, but it
 *     answers "may you hold a door credential". Reusing it would silently
 *     couple two unrelated policies — change one and the other moves with it.
 *   - `denyReviewer` is a WRITE guard and blocks MEMBER, which is right here by
 *     coincidence, but it also blocks nothing about bulk reads.
 *
 * Who may export: the roles that actually run the event — SUPER_ADMIN / ADMIN /
 * ORGANIZER — plus ONSITE (desk staff legitimately export the day's list) and
 * API-key callers (admin-equivalent, org-scoped, admin-minted). MEMBER,
 * REVIEWER, SUBMITTER, REGISTRANT and CRM_USER get 403.
 *
 * Note this is deliberately NARROWER than who may READ the list. A MEMBER can
 * still page through registrations on screen; they just can't take the whole
 * book away in one file. That asymmetry — read is not export — is the same one
 * `denyContactExport` established for contacts on July 16.
 */

import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";

const EXPORT_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "ONSITE", "WEBINARS"]);

/**
 * True when the caller may download the registrations list as a file.
 * Fails closed on an unknown/absent role.
 */
export function canExportRegistrations(
  role: string | null | undefined,
  isApiKey = false,
): boolean {
  if (isApiKey) return true;
  return !!role && EXPORT_ROLES.has(role);
}

/**
 * Guard for the export branch. Returns a 403 response when the caller may not
 * export, else null.
 *
 * Logs its own refusal so no call site can forget to (the repo's "every failure
 * path logs" rule — a silent 403 on a PII boundary is exactly what we don't
 * want to be blind to).
 */
export function denyRegistrationExport(ctx: {
  role: string | null | undefined;
  userId?: string | null;
  organizationId?: string | null;
  eventId?: string;
  fromApiKey?: boolean;
}): NextResponse | null {
  if (canExportRegistrations(ctx.role, ctx.fromApiKey ?? false)) return null;

  apiLogger.warn({
    msg: "registrations-export:forbidden",
    role: ctx.role ?? null,
    userId: ctx.userId ?? null,
    organizationId: ctx.organizationId ?? null,
    eventId: ctx.eventId ?? null,
  });

  return NextResponse.json(
    {
      error: "You don't have permission to export registrations.",
      code: "EXPORT_FORBIDDEN",
    },
    { status: 403 },
  );
}
