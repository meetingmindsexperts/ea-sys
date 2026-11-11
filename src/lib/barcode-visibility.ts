/**
 * Entry-barcode visibility — who may see the fields that let you walk through
 * the door: `Registration.qrCode` (the entry barcode) and
 * `Registration.dtcmBarcode` (the Dubai DTCM compliance credential).
 *
 * Decision record:
 *   - July 11, 2026 (check-in/badges review, H6/H7/H8): both credentials were
 *     returned via `include:` on the registration list + detail GETs, and
 *     NEITHER was in `FINANCIAL_KEYS` — so `redactFinancialFields`, the only
 *     redaction pass that runs for non-finance roles, never stripped them. A
 *     MEMBER (org-bound read-only viewer) and an internal-domain
 *     REGISTRANT could pull every attendee's entry barcode in one call and
 *     print/clone a badge.
 *
 * WHY THIS IS ITS OWN BOUNDARY (not folded into finance visibility): the
 * barcode boundary and the finance boundary are DIFFERENT. `FINANCE_ROLES`
 * includes MEMBER + ONSITE (they record payments), but:
 *   - MEMBER must NOT see the entry barcode — a read-only viewer (internal
 *     staff, per the Aug 14 2026 correction) has no reason to hold a door
 *     credential.
 *   - ONSITE MUST see it — desk staff print badges (which carry the barcode).
 * So barcode visibility is a strict subset that does not match either
 * `FINANCE_ROLES` or `canWrite`'s set — it needs its own predicate.
 *
 * Who may see the entry barcode: the roles that actually run the door +
 * badges — SUPER_ADMIN / ADMIN / ORGANIZER / ONSITE — plus API-key callers
 * (admin-equivalent, org-scoped, admin-minted). Everyone else (MEMBER,
 * REVIEWER, SUBMITTER, and a REGISTRANT looking at anything but their own row)
 * gets it stripped. A registrant's access to THEIR OWN barcode is a separate
 * ownership concern handled by the self-service portal + the barcode PNG route,
 * not this helper.
 */

// WHO may see barcodes is `barcode.view`, asked through `can()` (custom roles
// Phase 6, Oct 6, 2026); the role list and `canViewEntryBarcode` are gone.

/**
 * EVERY staff route that answers with a registration row asks this, not only
 * the list and the detail read (review of 243b7136, Nov 11, 2026). The save,
 * the create, the three check-in answers and the walk-in each returned the
 * whole row, or the code just assigned, to anyone who could call them, and a
 * MEMBER can call all four. `registrationForCaller` is that one line; a new
 * route that returns a registration uses it.
 *
 * WRITING the DTCM code has a rule of its own, `dtcmCodeWriteRefusal`: the
 * registration save accepted `dtcmBarcode` from anyone holding
 * `registrations.update`, while the two routes built to assign a code (the
 * spare pool and the DET purchase) both ask `dtcm.assign` AND `barcode.view`.
 */

/** A registration (or a list, or an object holding one) as this caller may see it. */
export function registrationForCaller<T>(maySeeCodes: boolean, value: T): T {
  return maySeeCodes ? value : redactBarcodeFields(value);
}

export type DtcmCodeWrite =
  /** The field is not in the request, or the caller may write it: nothing to do. */
  | { action: "allow" }
  /** A blank from someone who cannot write it: leave the stored code alone. */
  | { action: "drop"; wouldHaveCleared: boolean }
  /** A code from someone who cannot write it. */
  | { action: "refuse" };

/**
 * What the registration save does with a `dtcmBarcode` in its request.
 *
 * Someone who may write it (both keys): whatever they sent, as before.
 *
 * Someone who may not:
 * - a VALUE is refused. They are trying to hand someone a door credential.
 * - a BLANK is dropped, never applied. A screen that cannot see the code holds
 *   an empty field for it, and the registration sheet sent that blank on every
 *   save: a MEMBER correcting a spelling wiped the attendee's compliance code
 *   (found Nov 11, 2026; production held no DTCM code yet). Dropped rather
 *   than refused so a tab opened before this fix can still save its edit.
 *
 * The stored code is deliberately not compared with what was sent: answering
 * differently for a right and a wrong guess would tell a caller who cannot see
 * the code what it is.
 */
export function dtcmCodeWriteRefusal(args: { sent: string | null | undefined; mayWrite: boolean; storedCode: string | null }): DtcmCodeWrite {
  if (args.sent === undefined || args.mayWrite) return { action: "allow" };
  if (args.sent !== null && args.sent.trim() !== "") return { action: "refuse" };
  return { action: "drop", wouldHaveCleared: Boolean(args.storedCode) };
}

/** The credential columns on a registration payload. */
export const BARCODE_KEYS = ["qrCode", "dtcmBarcode"] as const;

/**
 * Recursively strip `qrCode` + `dtcmBarcode` from a registration (or array of
 * registrations). Mirrors `redactFinancialFields` — keys are dropped, not
 * nulled, so the shape matches "field was never selected". Non-objects pass
 * through untouched.
 */
export function redactBarcodeFields<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactBarcodeFields(v)) as unknown as T;
  }
  // A Date, a Prisma Decimal or any other class instance is a value, not a
  // record: rebuilding it from its own keys turned a registration's createdAt
  // into {} (the Registered column read "undefined NaN" for MEMBER).
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if ((BARCODE_KEYS as readonly string[]).includes(k)) continue;
    out[k] = redactBarcodeFields(v);
  }
  return out as T;
}
