/**
 * What Enter in the registration desk's search box does (docs/ONSITE_DESK_PLAN.md
 * §4). Pure and client-safe, so the branch order is pinned by a test rather
 * than living inside a click handler.
 *
 * One match is acted on; several ask the operator to choose; no match on
 * something shaped like a code (no whitespace, 4+ characters) is treated as a
 * scanned badge or confirmation barcode. Our entry codes are 19 digits or
 * `digits-NNN` and DTCM codes are UUIDs, so a scan never resolves locally to
 * a different person: digits alone read as a registration number only up to
 * 9 digits (`parseSerialQuery`).
 */

import { matchesRegistrationSearch, type SearchableRegistration } from "@/lib/registration-search";

/**
 * The desk's search: the Registrations page's rule, plus the full name in
 * either order ("john smith", "smith john"), because at a desk people say
 * both names. The shared rule stays as it is: the Registrations page's CSV
 * export must hold exactly the rows on its screen.
 */
export function matchesDeskSearch(r: SearchableRegistration, query: string): boolean {
  if (matchesRegistrationSearch(r, query)) return true;
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  const first = r.attendee.firstName.toLowerCase();
  const last = r.attendee.lastName.toLowerCase();
  return `${first} ${last}`.includes(q) || `${last} ${first}`.includes(q);
}

export interface DeskEnterCandidate {
  id: string;
  status: string;
  /** Money is owed, so the desk records it before admitting. */
  paymentDue: boolean;
}

export type DeskEnterAction =
  | { kind: "reprint"; id: string }
  | { kind: "pay"; id: string }
  | { kind: "check-in"; id: string }
  | { kind: "cancelled" }
  | { kind: "choose"; count: number }
  | { kind: "scan"; code: string }
  | { kind: "no-match" }
  | { kind: "none" };

// No whitespace and 4+ characters, and never an email: an address with no
// match is someone to register, not a barcode to send to the door.
const CODE_SHAPE = /^[^\s@]{4,}$/;

export function deskEnterAction(query: string, results: DeskEnterCandidate[]): DeskEnterAction {
  const text = query.trim();
  if (!text) return { kind: "none" };
  if (results.length > 1) return { kind: "choose", count: results.length };
  const only = results[0];
  if (!only) return CODE_SHAPE.test(text) ? { kind: "scan", code: text } : { kind: "no-match" };
  if (only.status === "CANCELLED") return { kind: "cancelled" };
  if (only.status === "CHECKED_IN") return { kind: "reprint", id: only.id };
  if (only.paymentDue) return { kind: "pay", id: only.id };
  return { kind: "check-in", id: only.id };
}

/**
 * Which waiting people the desk asks about this cycle, and where the next
 * cycle starts. The status route takes `size` ids; a longer list is asked
 * about in turn, wrapping, so nobody past the first batch is starved.
 */
export function nextPollBatch(ids: string[], offset: number, size: number): { batch: string[]; offset: number } {
  if (ids.length <= size) return { batch: ids, offset: 0 };
  const start = offset % ids.length;
  const batch = [...ids, ...ids].slice(start, start + size);
  return { batch, offset: (start + size) % ids.length };
}
