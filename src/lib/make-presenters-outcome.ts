/**
 * What "make the registration Complimentary now" came to, in the words the
 * Abstracts page shows (Nov 20, 2026; plan step 4). Pure, so the wording is
 * tested without a screen. It NAMES the abstracts whose author was not made a
 * presenter, by reason.
 */
export interface MakePresentersOutcome {
  made: string[];
  already: string[];
  /** `badgeKept`: a badge type someone chose was on it, so the badge was not set either. */
  skipped: { abstractId: string; part: string; code: string; message: string; badgeKept?: string }[];
  noRegistration: string[];
  /** Invited faculty: left exactly as they are. */
  faculty: string[];
  /** Complimentary (`made`: set now; otherwise it already was); the badge type someone had set was kept. */
  badgeKept: { abstractId: string; badgeType: string; made: boolean }[];
  notAccepted: string[];
  remaining: string[];
}

/** Enough numbers to act on without a list that fills the dialog. */
const MAX_NUMBERS = 30;

function numbers(ids: string[], numberOf: (id: string) => string): string {
  const shown = [...new Set(ids)].slice(0, MAX_NUMBERS).map(numberOf).join(", ");
  const more = new Set(ids).size - MAX_NUMBERS;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** True when something asked for did not happen. */
export function makePresentersNeedsAttention(o: MakePresentersOutcome): boolean {
  return o.skipped.length > 0 || o.noRegistration.length > 0 || o.remaining.length > 0 || o.notAccepted.length > 0;
}

function skipLead(s: MakePresentersOutcome["skipped"][number]): string {
  if (s.part !== "paymentStatus") return "Left as it is";
  if (s.badgeKept) return `Left as it is (payment status not changed, badge kept as "${s.badgeKept}")`;
  return "Payment status left as it is (the badge is Presenter)";
}

export function describeMakePresenters(o: MakePresentersOutcome, numberOf: (id: string) => string): string[] {
  const lines: string[] = [];
  if (o.made.length > 0) {
    lines.push(`Presenters: ${count(new Set(o.made).size, "author's registration is", "authors' registrations are")} now Complimentary, with a Presenter badge.`);
  }
  if (o.already.length > 0) lines.push(`Already Complimentary with the badge: ${numbers(o.already, numberOf)}.`);
  if (o.noRegistration.length > 0) {
    lines.push(`No registration yet, so nothing to make Complimentary: ${numbers(o.noRegistration, numberOf)}. Give one from the speaker's page.`);
  }
  if (o.faculty.length > 0) {
    lines.push(`On the Faculty type (invited speakers), left as they are: ${numbers(o.faculty, numberOf)}.`);
  }
  // A badge someone set by hand is not overwritten: said per badge, so the organiser can change it on purpose.
  // "Made" only where the payment status was set in this run (review of 8eaa3550, MED).
  const byBadge = new Map<string, string[]>();
  for (const b of o.badgeKept) {
    const line = `${b.made ? "Made Complimentary" : "Already Complimentary"}, badge kept as "${b.badgeType}"`;
    byBadge.set(line, [...(byBadge.get(line) ?? []), b.abstractId]);
  }
  for (const [line, ids] of byBadge) lines.push(`${line}: ${numbers(ids, numberOf)}.`);
  // One line per reason: "has a payment on it" and "paid by a sponsor" ask for different things.
  // Where only the payment status was refused the badge is Presenter, unless one someone chose was kept;
  // where the whole row was refused nothing was changed.
  const byReason = new Map<string, string[]>();
  for (const s of o.skipped) {
    const key = `${skipLead(s)}|${s.message}`;
    byReason.set(key, [...(byReason.get(key) ?? []), s.abstractId]);
  }
  for (const [key, ids] of byReason) {
    const [lead, message] = key.split("|");
    lines.push(`${lead}: ${numbers(ids, numberOf)}. ${message}`);
  }
  if (o.notAccepted.length > 0) {
    lines.push(`No longer accepted, so nothing was changed: ${numbers(o.notAccepted, numberOf)}.`);
  }
  if (o.remaining.length > 0) lines.push(`Not reached: ${numbers(o.remaining, numberOf)}. Run it again from Registrations, Abstract accepted.`);
  return lines;
}
