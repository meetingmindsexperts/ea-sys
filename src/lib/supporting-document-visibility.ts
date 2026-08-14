/**
 * Supporting-document visibility — who may DOWNLOAD the file a registrant
 * uploaded to substantiate their rate.
 *
 * ADMIN / ORGANIZER / SUPER_ADMIN only, matching the two closest private-
 * document routes: speaker documents (passport photocopies) and reimbursement
 * documents (passport scans + bank details), both on the bare `denyReviewer`.
 *
 * Narrowed Aug 14, 2026. It shipped two days earlier on
 * `REGISTRATION_DESK_ALLOW`, justified as "desk staff verify the letter at the
 * registration desk" — a convenience argument wearing a needs argument's
 * clothes. Nobody reads an institutional letter during the arrival rush;
 * verifying entitlement to a discounted RATE is a back-office judgement. And
 * since Aug 13 an organizer can name the requested document anything, so
 * "Passport copy" now flows through this same pipe.
 *
 * WHY ITS OWN PREDICATE. It matches no existing set, so it cannot borrow one:
 *   - `FINANCE_ROLES` includes MEMBER + ONSITE (they record payments)
 *   - `canViewEntryBarcode` includes ONSITE (badges), excludes MEMBER
 *   - `canViewContacts` includes MEMBER, excludes ONSITE
 * This one excludes both — ONSITE because it is the less-trusted population
 * (temp staff, contractors, vendors), MEMBER because although it is internal
 * staff it sees every event in the org where ONSITE is assignment-gated.
 * Neither dimension dominates, so neither earns the grant.
 *
 * The resulting asymmetry is deliberate: ONSITE can CHECK SOMEONE IN but not
 * READ THEIR DOCUMENT. Checking in is scanning a barcode; reading the document
 * is an entitlement judgement. Reversible in one line if a real desk workflow
 * turns up — see docs/PER_TYPE_DOCUMENT_UPLOAD_PLAN.md.
 */

const SUPPORTING_DOCUMENT_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);

/**
 * True when the role may download a registration's supporting document.
 * Fails closed on an unknown or absent role.
 *
 * Takes NO `isApiKey` escape hatch, unlike `canViewEntryBarcode`: nothing
 * streams this file programmatically today, and a key sitting in an n8n
 * workflow is a poor place to be able to pull passport scans from. Add it when
 * an integration needs it, as a decision rather than an inheritance.
 */
export function canViewSupportingDocument(role: string | null | undefined): boolean {
  return !!role && SUPPORTING_DOCUMENT_ROLES.has(role);
}
