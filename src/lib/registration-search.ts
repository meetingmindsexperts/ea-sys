/**
 * The Registrations page search box, shared by the list (filtered in the
 * browser) and the CSV export (`q` on the registrations GET), so the file
 * holds exactly the rows on screen.
 *
 * Digits alone are a registration number (owner, Oct 26, 2026): "2", "002"
 * and "#002" find registration 002 and nothing else, because "contains 2"
 * would list 002, 012, 020, 120 ... at a large event. Anything else matches
 * name, email or organisation as before.
 *
 * Client-safe (no imports).
 */

/** "2", "002" or "#002" → 2. Null for anything that is not a number. */
export function parseSerialQuery(query: string): number | null {
  const match = /^#?(\d{1,9})$/.exec(query.trim());
  return match ? Number(match[1]) : null;
}

export interface SearchableRegistration {
  serialId?: number | null;
  attendee: { firstName: string; lastName: string; email: string; organization?: string | null };
}

export function matchesRegistrationSearch(r: SearchableRegistration, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const serial = parseSerialQuery(q);
  if (serial !== null) return r.serialId === serial;
  const a = r.attendee;
  return [a.firstName, a.lastName, a.email, a.organization ?? ""].some((v) => v.toLowerCase().includes(q));
}
