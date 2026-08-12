/**
 * Resident / Trainee official letter — client-safe, pure.
 *
 * A Resident rate is a discounted rate, so organizers need the registrant to
 * substantiate their entitlement to it: a letter from their institution, in
 * English, on letterhead, signed and stamped.
 *
 * ── Why the TICKET TYPE and not the role ────────────────────────────────────
 * "Resident" exists twice in this system: as an `AttendeeRole` and as a ticket
 * type name (17 events carry one). The letter proves entitlement to a RATE, and
 * the rate is the ticket type — a resident who pays the full Physician rate is
 * claiming no discount and has nothing to prove. Keying on the ticket type also
 * catches the real-world variants on prod: "Student/Resident", "Trainee /
 * Student".
 *
 * ── Whether it BLOCKS is the organizer's call ───────────────────────────────
 * Some events want the letter in hand before they will hold a discounted place;
 * others would rather take the registration and chase the paperwork than lose
 * the delegate at the form. That is a policy decision, not ours, so it lives in
 * `Event.settings.residentLetter.required` and defaults to OFF: an event that
 * has never seen this screen keeps behaving exactly as it did.
 *
 * Note the asymmetry with the member/student evidence fields beside it, which
 * are unconditionally required. Those ask for a number the registrant knows by
 * heart; this asks for a document they may not have to hand at 11pm.
 */

/**
 * Matches the ticket types whose rate needs substantiating.
 *
 * Deliberately a substring match on the NAME, the same mechanism the member and
 * student evidence fields already use. It is loose by design — an organizer
 * naming a type "Resident (In-Training)" should not have to know a rule exists.
 */
const RESIDENT_TICKET_TYPE_PATTERN = /resident|trainee/i;

/** Does a registration on this ticket type need an official letter? */
export function requiresResidentLetter(ticketTypeName: string | null | undefined): boolean {
  return !!ticketTypeName && RESIDENT_TICKET_TYPE_PATTERN.test(ticketTypeName);
}

export interface ResidentLetterSettings {
  /** When true the letter must be attached before the registration is accepted. */
  required: boolean;
}

export const DEFAULT_RESIDENT_LETTER_SETTINGS: ResidentLetterSettings = { required: false };

/**
 * Parsed settings from an `Event.settings` blob.
 *
 * Fails OPEN (not required) on anything unparseable. A corrupt settings blob
 * must never lock a paying delegate out of a registration form — the cost of
 * wrongly requiring is a lost registration, the cost of wrongly not requiring
 * is a letter chased by email.
 */
export function readResidentLetterSettings(settings: unknown): ResidentLetterSettings {
  if (!settings || typeof settings !== "object") return DEFAULT_RESIDENT_LETTER_SETTINGS;
  const raw = (settings as Record<string, unknown>).residentLetter;
  if (!raw || typeof raw !== "object") return DEFAULT_RESIDENT_LETTER_SETTINGS;
  return { required: (raw as Record<string, unknown>).required === true };
}

// ── Upload contract ─────────────────────────────────────────────────────────

export const RESIDENT_LETTER_MAX_SIZE = 5 * 1024 * 1024;

/** Accept attribute for the file input, and the MIME allow-list on the server. */
export const RESIDENT_LETTER_ACCEPT = "application/pdf,image/jpeg,image/png";

/**
 * Where an accepted upload lands. Files are served ONLY through the authed
 * staff route: an institutional letter carries a named person, their employer
 * and a signature, so the public `/uploads` catch-all blocks this prefix.
 */
export const RESIDENT_LETTER_PATH_PREFIX = "/uploads/resident-letters/";

/**
 * Is this a path our own upload route produced?
 *
 * The registration POST takes this value from the CLIENT, so it is attacker
 * controlled. Without this check a crafted request could store any string —
 * `../../../etc/passwd`, or a path pointing at another event's private
 * directory — and the staff download route would later resolve it. Validating
 * the shape on the way IN means the read side never has to trust the column.
 */
export function isResidentLetterPath(url: string): boolean {
  return (
    url.startsWith(RESIDENT_LETTER_PATH_PREFIX) &&
    !url.includes("..") &&
    !url.includes("\0") &&
    // uploads/resident-letters/{eventId}/{uuid}.{ext} and nothing deeper
    /^\/uploads\/resident-letters\/[A-Za-z0-9_-]+\/[A-Za-z0-9-]+\.(pdf|jpg|png)$/.test(url)
  );
}
