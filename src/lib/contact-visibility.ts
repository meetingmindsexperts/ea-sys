/**
 * Contact-store (org CRM) READ visibility — who may list, view, export, or pull
 * the tag vocabulary of the organization's contact book.
 *
 * Decision record:
 *   - July 14, 2026 (contacts review, H1): the four contacts READ routes
 *     (`GET /api/contacts`, `/api/contacts/[contactId]`, `/api/contacts/export`,
 *     `/api/contacts/tags`) authorized on `getOrgContext` ALONE. `denyReviewer`
 *     guards only the writes. Since the June-16 internal-domain rule, ONSITE
 *     (per-event desk temps) and internal-domain REGISTRANTs are org-bound —
 *     so any of them could call `/api/contacts/export` and download the ENTIRE
 *     organization's CRM (every contact's email, phone, bio and the organizer's
 *     private `notes`) as a CSV, un-audited and un-rate-limited.
 *
 * WHY THIS IS ITS OWN BOUNDARY (not `denyReviewer`, not finance, not barcodes):
 *   - `denyReviewer` is a WRITE guard; it happens to block MEMBER, but MEMBER
 *     is explicitly allowed to READ the CRM (owner decision, July 14).
 *   - `FINANCE_ROLES` includes ONSITE — but a desk temp must NOT hold the org's
 *     whole contact book.
 *   - `BARCODE_ROLES` includes ONSITE and excludes MEMBER — the exact inverse
 *     of what we want here.
 * None of the existing predicates has the right shape, so the CRM gets its own.
 *
 * Who may read the contact store (owner decision, July 14, 2026):
 *   SUPER_ADMIN / ADMIN / ORGANIZER — staff who run events.
 *   MEMBER — the org-bound read-only viewer (leadership / auditor / sponsor-side).
 *            Sees contacts INCLUDING notes; it is a read-only role by design.
 *   API keys — admin-equivalent, org-scoped, admin-minted.
 * Everyone else is blocked: ONSITE (desk temp, event-scoped by design),
 * REGISTRANT (an attendee — internal-domain ones are org-bound but are not
 * staff), REVIEWER, SUBMITTER.
 *
 * Fails closed: an unknown/absent role gets nothing.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";

// CRM_USER is included (owner decision, 2026-07-15) so the sales team can search
// the event contact store to LINK a rep to their event registration. This does
// expose the HCP list to sales — an accepted PII tradeoff, recorded here.
const CONTACT_READ_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "CRM_USER"]);

// EXPORT is a strictly narrower boundary than read (owner decision, 2026-07-16,
// contacts review round 2, M-A): the CRM_USER read grant exists to SEARCH the
// store and link a rep to their registration — a per-record capability. The CSV
// export is the whole org book in one file, including the organizer's private
// `notes`; that is wider than the recorded rationale for a sales-temp role, so
// CRM_USER may read but NOT export. Everyone else mirrors the read set.
const CONTACT_EXPORT_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"]);

/**
 * True when the role may read the org contact store.
 * Pass `isApiKey` for programmatic callers (admin-equivalent).
 */
export function canViewContacts(
  role: string | null | undefined,
  isApiKey = false,
): boolean {
  if (isApiKey) return true;
  return !!role && CONTACT_READ_ROLES.has(role);
}

/**
 * Returns a 403 if the caller's org context may not read the contact store,
 * else null. Logged HERE so no call site can forget (payments review M12) —
 * a restricted role probing the CRM must be visible in /logs.
 *
 * Usage (after the `getOrgContext` null check):
 *   const denied = denyContactAccess(ctx);
 *   if (denied) return denied;
 */
export function denyContactAccess(ctx: {
  role: string | null;
  userId: string | null;
  fromApiKey: boolean;
}) {
  if (canViewContacts(ctx.role, ctx.fromApiKey)) return null;

  apiLogger.warn({
    msg: "auth-guard:contacts-read-denied",
    role: ctx.role,
    userId: ctx.userId,
  });
  return NextResponse.json(
    { error: "The contact store is not available to your role", code: "CONTACTS_FORBIDDEN" },
    { status: 403 },
  );
}

/**
 * True when the role may bulk-export the org contact store as CSV.
 * Narrower than `canViewContacts` — see CONTACT_EXPORT_ROLES. API keys are
 * admin-equivalent (admin-minted, org-scoped) and may export.
 */
export function canExportContacts(
  role: string | null | undefined,
  isApiKey = false,
): boolean {
  if (isApiKey) return true;
  return !!role && CONTACT_EXPORT_ROLES.has(role);
}

/**
 * Returns a 403 if the caller may not bulk-export the contact store, else
 * null. Runs AFTER `denyContactAccess` on the export route — this is the
 * second, narrower gate. Logged here so no call site can forget.
 */
export function denyContactExport(ctx: {
  role: string | null;
  userId: string | null;
  fromApiKey: boolean;
}) {
  if (canExportContacts(ctx.role, ctx.fromApiKey)) return null;

  apiLogger.warn({
    msg: "auth-guard:contacts-export-denied",
    role: ctx.role,
    userId: ctx.userId,
  });
  return NextResponse.json(
    { error: "Exporting the contact store is not available to your role", code: "CONTACTS_EXPORT_FORBIDDEN" },
    { status: 403 },
  );
}
