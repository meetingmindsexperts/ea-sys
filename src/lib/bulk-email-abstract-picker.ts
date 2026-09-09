/**
 * The abstract picker inside the bulk-email dialog (Sep 9, 2026).
 *
 * Client-safe: pure functions over the rows the Communications page already
 * holds. The organiser filters by status and ticks specific abstracts by
 * number, title or author email; the ticked ids become `recipientIds`
 * (abstract ids, which is what the server's abstracts resolver keys on), and
 * the count shown is computed by the SAME scope rule the server applies
 * (bulk-email-audience.ts), restricted to the ticked rows when there are any.
 */
import { formatAbstractSerial } from "@/lib/abstract-serial";
import { abstractStatusLabel } from "@/app/(dashboard)/events/[eventId]/abstracts/abstract-enums";
import {
  ABSTRACT_DECISION_STATUSES,
  ABSTRACT_NOT_RESENDABLE_STATUSES,
  PER_ABSTRACT_EMAIL_TYPES,
  abstractInSendScope,
  abstractStatusAllowedForType,
} from "@/lib/bulk-email-audience";

export interface AbstractPickerOption {
  id: string;
  serialId: number | null;
  title: string;
  status: string;
  /** The submitting author's email; the dedup key for per-author types. */
  email: string;
  authorName: string;
}

const ALL_ABSTRACT_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "ACCEPTED",
  "REJECTED",
  "REVISION_REQUESTED",
  "WITHDRAWN",
] as const;

// The status wording is the abstracts page's own map, so the picker can never
// spell a status differently from the list it mirrors.
export { abstractStatusLabel };

/** The statuses the dialog may OFFER for a type: exactly the ones the server accepts. */
export function abstractStatusOptionsFor(emailType: string): readonly string[] {
  return ALL_ABSTRACT_STATUSES.filter((s) => abstractStatusAllowedForType(emailType, s));
}

/** What "all" means for this type, in the organiser's words. */
export function abstractScopeLabel(emailType: string): string {
  if (emailType === "abstract-confirmation") {
    return `All except ${ABSTRACT_NOT_RESENDABLE_STATUSES.map(abstractStatusLabel).join(" and ").toLowerCase()} (default)`;
  }
  if (emailType === "abstract-decision") {
    return `Decided: ${ABSTRACT_DECISION_STATUSES.map(abstractStatusLabel).join(", ").toLowerCase()} (default)`;
  }
  if (emailType === "abstract-reminder") return "Drafts only (default)";
  return "All statuses";
}

/**
 * A status the current type cannot send resolves to "all". The type picker
 * and the status picker are independent controls, so switching type after
 * picking a status must fall back to the type's default scope rather than
 * carry a value the server would refuse with INVALID_FILTER.
 */
export function resolveAbstractStatusFilter(emailType: string, status: string): string {
  if (!status || status === "all") return "all";
  return abstractStatusAllowedForType(emailType, status) ? status : "all";
}

function matchesSearch(o: AbstractPickerOption, needle: string): boolean {
  if (!needle) return true;
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  const serial = o.serialId != null ? formatAbstractSerial(o.serialId).toLowerCase() : "";
  // "7" finds A-007; "a-007" and "007" do too.
  const bare = o.serialId != null ? String(o.serialId) : "";
  return (
    serial.includes(q) ||
    (bare !== "" && (bare === q.replace(/^a-?0*/i, "") || serial.endsWith(q.replace(/^a-?/i, "")))) ||
    o.title.toLowerCase().includes(q) ||
    o.email.toLowerCase().includes(q) ||
    o.authorName.toLowerCase().includes(q)
  );
}

/** Rows the picker shows: in the type's scope, matching the search, by number. */
export function filterAbstractOptions(
  options: readonly AbstractPickerOption[],
  args: { emailType: string; status: string; search: string },
): AbstractPickerOption[] {
  return options
    .filter((o) => abstractInSendScope(o.status, args.emailType, args.status))
    .filter((o) => matchesSearch(o, args.search))
    .sort((a, b) => (a.serialId ?? Number.MAX_SAFE_INTEGER) - (b.serialId ?? Number.MAX_SAFE_INTEGER));
}

/**
 * How many EMAILS this send produces. Per-abstract types send one per
 * abstract in scope; per-author types dedupe by email, as the resolver does.
 * `selectedIds` restricts to the ticked rows (still within scope, because the
 * server applies the status filter on top of `recipientIds`).
 */
export function countAbstractRecipients(
  options: readonly AbstractPickerOption[],
  args: { emailType: string; status: string; selectedIds?: ReadonlySet<string> },
): number {
  const inScope = options.filter(
    (o) =>
      abstractInSendScope(o.status, args.emailType, args.status) &&
      (!args.selectedIds || args.selectedIds.size === 0 || args.selectedIds.has(o.id)),
  );
  if (PER_ABSTRACT_EMAIL_TYPES.has(args.emailType)) return inScope.length;
  return new Set(inScope.map((o) => o.email.trim().toLowerCase()).filter(Boolean)).size;
}
