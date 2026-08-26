/**
 * The walk-up DTCM warning.
 *
 * On a Dubai event the desk registers someone at the counter and prints their
 * badge seconds later. If the spare pool was empty, the registration still
 * succeeds — deliberately, because a compliance code is not a precondition for
 * existing — and the badge simply prints with no compliance QR on it.
 *
 * Nothing else on screen says so. The registration row looks normal, the badge
 * looks normal to anyone who does not know a QR should be there, and the gap is
 * discovered by a DTCM inspector rather than by us. So the moment to say it is
 * the moment it happens, at the counter, to the person who can still fix it.
 *
 * Client-safe and pure on purpose: two surfaces create registrations (the
 * full-page form and the quick-add dialog) and a condition written twice is a
 * condition that drifts once.
 */

/**
 * The message to show after a registration is created, or null when there is
 * nothing to say.
 *
 * Deliberately silent for VIRTUAL attendees: they get no badge at all, so they
 * need no code, and warning about one would be noise the desk learns to ignore.
 */
export function dtcmWalkupWarning(args: {
  /** `Event.requiresDtcmBarcode` — false on every non-Dubai event. */
  requiresDtcm: boolean | null | undefined;
  attendanceMode?: string | null;
  /** The code on the row the server just returned. */
  dtcmBarcode?: string | null;
}): string | null {
  if (!args.requiresDtcm) return null;
  if (args.attendanceMode === "VIRTUAL") return null;
  if (args.dtcmBarcode) return null;
  return "Registered, but no DTCM code was assigned — the spare pool is empty. Their badge will print without a compliance QR. Import more codes, or assign one from the registration.";
}
