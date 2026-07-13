/**
 * Field-level diffs from an AuditLog `changes` blob — the "what actually
 * changed" behind an otherwise opaque "Registration updated" row.
 *
 * Client-safe: pure functions over plain objects, no `db`, no Node built-ins.
 * It lives here rather than in `activity-feed.ts` (which imports Prisma and is
 * server-only) because BOTH consumers need it: the per-person timeline builds
 * diffs on the server, and the org-wide Activity feed is a client component that
 * receives the raw `changes` blob and must render the same thing from it.
 *
 * Keeping one implementation is not tidiness — DIFF_SKIP_KEYS carries a security
 * rule (`dtcmBarcode` and `qrCode` are physical-access credentials and must
 * never be rendered into an edit history), and a second copy is a second place
 * for that rule to be forgotten.
 */
import type { ActivityFieldDiff } from "./activity-feed-types";
import { redactFinancialFields } from "./finance-visibility";

/**
 * Keys that are noise in an edit history (identity / bookkeeping / internal
 * blobs), applied at both the top level and the nested `attendee` level.
 *
 * `qrCode` and `dtcmBarcode` are here for a stronger reason than noise: they are
 * door credentials (the July-11 barcode-visibility boundary). Full-row audit
 * snapshots contain them, so a barcode correction would otherwise render its
 * before → after straight into an activity feed.
 */
const DIFF_SKIP_KEYS = new Set<string>([
  "id",
  "createdAt",
  "updatedAt",
  "eventId",
  "organizationId",
  "userId",
  "attendeeId",
  "customFields",
  "attempts",
  "externalId",
  "qrCode",
  "dtcmBarcode",
  "serialId",
]);

/** camelCase → "Title case" label, e.g. paymentStatus → "Payment status". */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Render a scalar/array value for the diff. Returns null to skip (objects). */
function formatDiffValue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 119)}…` : v;
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) {
      return v.length ? v.map((x) => String(x)).join(", ") : "—";
    }
    return null; // array of objects — too noisy
  }
  return null; // nested object — handled separately for `attendee`
}

const MAX_DIFFS = 15;

/** Diff one flat object level, pushing changed scalar/array keys. */
function diffLevel(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix: string,
  out: ActivityFieldDiff[],
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (DIFF_SKIP_KEYS.has(k)) continue;
    if (out.length >= MAX_DIFFS) return;
    const b = before[k];
    const a = after[k];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    const bf = formatDiffValue(b);
    const af = formatDiffValue(a);
    if (bf === null || af === null) continue; // skip object-valued fields here
    out.push({ field: prefix ? `${prefix}: ${humanizeKey(k)}` : humanizeKey(k), before: bf, after: af });
  }
}

/**
 * Build field-level diffs from an audit row's `changes` blob. Handles the
 * registration/speaker UPDATE shape `{ before, after }` (both full rows incl. a
 * nested `attendee`). Financial fields are stripped first for non-finance
 * viewers. Returns [] for non-UPDATE shapes (e.g. DELETE's `{ deleted }`, bulk
 * summaries) — an empty array means "nothing renderable here", not an error.
 */
export function computeAuditDiffs(
  changes: unknown,
  canViewFinance: boolean,
): ActivityFieldDiff[] {
  if (!changes || typeof changes !== "object") return [];
  const c = changes as Record<string, unknown>;
  if (!c.before || !c.after || typeof c.before !== "object" || typeof c.after !== "object") {
    return [];
  }
  let before = c.before as Record<string, unknown>;
  let after = c.after as Record<string, unknown>;
  if (!canViewFinance) {
    before = redactFinancialFields(before);
    after = redactFinancialFields(after);
  }

  const out: ActivityFieldDiff[] = [];
  // Top-level (registration/speaker) scalar fields.
  diffLevel(before, after, "", out);
  // One level into the nested attendee (phone, registrationType, etc.).
  const ba = before.attendee;
  const aa = after.attendee;
  if (ba && aa && typeof ba === "object" && typeof aa === "object" && !Array.isArray(ba) && !Array.isArray(aa)) {
    diffLevel(ba as Record<string, unknown>, aa as Record<string, unknown>, "Attendee", out);
  }
  return out;
}
