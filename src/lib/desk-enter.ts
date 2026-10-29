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
