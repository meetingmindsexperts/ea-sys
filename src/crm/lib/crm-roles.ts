/**
 * CRM role predicates — PURE, and deliberately CLIENT-SAFE.
 *
 * ⚠ THIS FILE MUST NOT IMPORT `next/server`, the logger, `db`, or any Node builtin.
 *
 * It is imported by "use client" components (the sidebar, the deals board, the
 * contact card) so the UI can hide an action the API would refuse. Anything with a
 * Node import in this graph gets bundled as `undefined` by Next — the build fails if
 * you're lucky, and if you're not, the symptom is "the button does nothing and there
 * are no logs". That is exactly what happened when these predicates lived alongside
 * the response guards, which import `apiLogger` (→ `fs`).
 *
 * The HTTP guards (`denyCrmAccess`, `denyCrmWrite`) live in `crm-visibility.ts`,
 * which is server-only and imports from here. Same split as finance-visibility.
 *
 * ─── The matrix (owner decisions, CRM_MODULE_PLAN.md §9 d4) ───────────────────
 *
 *                     read board   own/write   see money
 *   SUPER_ADMIN/ADMIN     ✓            ✓           ✓
 *   ORGANIZER             ✓            ✓           ✓
 *   MEMBER                ✓            ✗           ✗   ← the interesting row
 *   ONSITE                ✗            ✗           ✗
 *   REVIEWER/SUBMITTER    ✗            ✗           ✗
 *   REGISTRANT            ✗            ✗           ✗
 *   API key               ✓            ✓           ✓
 *
 * WHY THESE AREN'T AN EXISTING PREDICATE. Per the AGENTS.md rule: reaching for a
 * "close enough" predicate is the signal to write a new one.
 *   - `canViewContacts` (staff + MEMBER, no ONSITE) is the closest cousin, but says
 *     nothing about deal ownership or about redacting money.
 *   - `FINANCE_ROLES` includes ONSITE and MEMBER — reusing it would hand a desk temp
 *     the sponsorship pipeline.
 *   - `denyReviewer` is a WRITE guard that blocks MEMBER — who is exactly the role we
 *     want READING the board (leadership).
 *
 * All three predicates fail closed: an unknown or absent role gets nothing.
 */

/** Roles that may READ the CRM (companies, deals board, tasks, notes). */
const CRM_READ_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"]);

/** Roles that may OWN a deal / be assigned a task — i.e. act, not just look. */
const CRM_STAFF_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);

/**
 * True when the role may read the CRM at all.
 * `isApiKey` callers are admin-equivalent (org-scoped, admin-minted).
 */
export function canViewCrm(role: string | null | undefined, isApiKey = false): boolean {
  if (isApiKey) return true;
  return !!role && CRM_READ_ROLES.has(role);
}

/**
 * True when the role may own deals / be assigned tasks, and may write.
 * NOTE this excludes MEMBER — who can see the board but never act on it.
 */
export function canOwnDeals(role: string | null | undefined, isApiKey = false): boolean {
  if (isApiKey) return true;
  return !!role && CRM_STAFF_ROLES.has(role);
}

/**
 * True when the caller may see deal VALUES (money).
 *
 * Deliberately NOT `canViewFinance()`. MEMBER *is* finance-capable elsewhere in
 * EA-SYS (desk staff record payments) — but MEMBER is also the account we hand to
 * sponsor-side stakeholders, and a sponsor must not be able to read every RIVAL
 * sponsor's deal value off the board. This is the one place the existing finance
 * boundary is too generous, so the CRM narrows it rather than inheriting it.
 */
export function canViewDealValues(
  role: string | null | undefined,
  isApiKey = false,
): boolean {
  if (isApiKey) return true;
  return !!role && CRM_STAFF_ROLES.has(role);
}
