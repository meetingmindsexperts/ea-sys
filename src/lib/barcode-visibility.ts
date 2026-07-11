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
 *     MEMBER (read-only sponsor-side observer) and an internal-domain
 *     REGISTRANT could pull every attendee's entry barcode in one call and
 *     print/clone a badge.
 *
 * WHY THIS IS ITS OWN BOUNDARY (not folded into finance visibility): the
 * barcode boundary and the finance boundary are DIFFERENT. `FINANCE_ROLES`
 * includes MEMBER + ONSITE (they record payments), but:
 *   - MEMBER must NOT see the entry barcode — a leadership/auditor/sponsor-side
 *     viewer has no reason to hold a door credential.
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

const BARCODE_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "ONSITE"]);

/** True when the role may see entry / DTCM barcodes on a registration payload.
 *  Fails closed. Pass `isApiKey` for programmatic callers (admin-equivalent). */
export function canViewEntryBarcode(
  role: string | null | undefined,
  isApiKey = false,
): boolean {
  if (isApiKey) return true;
  return !!role && BARCODE_ROLES.has(role);
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
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if ((BARCODE_KEYS as readonly string[]).includes(k)) continue;
    out[k] = redactBarcodeFields(v);
  }
  return out as T;
}
