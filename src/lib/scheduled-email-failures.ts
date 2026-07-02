/**
 * The failure-format contract for scheduled emails, shared by the worker (which
 * writes it) and the Communications list UI (which reads it).
 *
 * `ScheduledEmail.lastError` is overloaded:
 *   - SENT-with-partial-failures → a JSON array of {email, error} (the per-
 *     recipient bounces), capped at MAX_STORED_ERRORS. `failureCount` holds the
 *     TRUE total, so the UI can show "…and N more" when the list was truncated.
 *   - whole-row FAILED (send threw before/at dispatch) → a plain error string.
 *   - success with no failures → null.
 *
 * Keeping the cap + the parser together means the write side and the read side
 * can't drift on the format.
 */

export type FailedRecipient = { email: string; error: string };

/**
 * How many per-recipient failures to persist in `lastError`. Bounds the Text
 * blob; beyond a couple hundred it's a systemic problem that's already visible
 * in the head of the list (and `failureCount` still reports the real total).
 */
export const MAX_STORED_ERRORS = 200;

/**
 * Parse `lastError` into a per-recipient failure list. Returns the list only
 * when it's the JSON-array form (SENT-with-failures); returns null for a plain
 * string (whole-row failure) or anything unparseable/malformed.
 */
export function parseFailedRecipients(lastError: string | null): FailedRecipient[] | null {
  if (!lastError) return null;
  try {
    const parsed = JSON.parse(lastError);
    if (
      Array.isArray(parsed) &&
      parsed.every((x) => x && typeof x === "object" && typeof x.email === "string")
    ) {
      return parsed as FailedRecipient[];
    }
  } catch {
    // plain-string error (whole-row failure) — not a recipient list
  }
  return null;
}
