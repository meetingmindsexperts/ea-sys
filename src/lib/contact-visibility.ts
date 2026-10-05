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
 *   MEMBER — the org-bound read-only viewer (internal staff; the older
 *   "sponsor-side" wording was corrected Aug 14, 2026).
 *            Sees contacts INCLUDING notes; it is a read-only role by design.
 *   API keys — admin-equivalent, org-scoped, admin-minted.
 * Everyone else is blocked: ONSITE (desk temp, event-scoped by design),
 * REGISTRANT (an attendee — internal-domain ones are org-bound but are not
 * staff), REVIEWER, SUBMITTER.
 *
 * Fails closed: an unknown/absent role gets nothing.
 */

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

// The routes no longer call a deny helper here: since Oct 5, 2026 (custom
// roles Phase 2) they gate on `contacts.read` / `contacts.export` through
// `requirePermission`, whose system-role grants match these two predicates
// (pinned by system-roles-parity.test.ts). The predicates stay for the
// callers that still read them (email logs, the CRM, supporting documents).
