/**
 * What "make the registration Complimentary now" came to, in the words the
 * Abstracts page shows (Nov 20, 2026; plan step 4). Pure, so the wording is
 * tested without a screen. It NAMES the abstracts whose author was not made a
 * presenter, by reason.
 */
export interface MakePresentersOutcome {
  made: string[];
  already: string[];
  skipped: { abstractId: string; part: string; code: string; message: string }[];
  noRegistration: string[];
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
  return o.skipped.length > 0 || o.noRegistration.length > 0 || o.remaining.length > 0;
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
  // One line per reason: "has a payment on it" and "paid by a sponsor" ask for different things.
  const byReason = new Map<string, string[]>();
  for (const s of o.skipped) byReason.set(s.message, [...(byReason.get(s.message) ?? []), s.abstractId]);
  for (const [message, ids] of byReason) lines.push(`Payment status left as it is: ${numbers(ids, numberOf)}. ${message}`);
  if (o.remaining.length > 0) lines.push(`Not reached: ${numbers(o.remaining, numberOf)}. Run it again from Registrations, Abstract accepted.`);
  return lines;
}
