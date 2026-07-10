/**
 * Zoom host-credential visibility — who may see the fields that grant CONTROL
 * of a meeting/webinar, as opposed to the fields that merely let you attend.
 *
 * Decision record:
 *   - July 10, 2026 (program/agenda review, BLOCKER B1): the dashboard sessions
 *     LIST returned `zoomMeeting.startUrl` (the Zoom **host** start link),
 *     `streamKey` and `passcode` to every caller with event access. That GET has
 *     no `denyReviewer`, and `buildEventAccessWhere` deliberately grants event
 *     access to the org-null attendee roles by linkage — so a REGISTRANT who
 *     paid for the event could call the endpoint directly, take the host link,
 *     and start/hijack the webinar as host (or lift the raw RTMP stream key).
 *
 * The boundary:
 *   - `startUrl`  — a signed HOST link. Whoever holds it IS the host.
 *   - `streamKey` — the RTMP ingest secret. Whoever holds it can publish to the
 *                   live stream.
 *   - `passcode`  — the meeting passcode. Not host control, but it is the gate
 *                   an unregistered person would otherwise need; the public
 *                   join path mints its own credentials, so nothing legitimate
 *                   needs the raw passcode outside the host surfaces.
 *
 * `joinUrl` is deliberately NOT host-only: it's the attendee link, already
 * shared with registrants by email.
 *
 * Only the roles that actually run the event may see these. This is a
 * *narrower* set than `canViewFinance` (which includes MEMBER + ONSITE, the
 * registration-desk operators) — desk staff record payments, they do not host
 * webinars. It matches `canWrite`'s set, but is kept as its own predicate so
 * the two boundaries can move independently.
 *
 * API-key callers are admin-equivalent (an org admin minted the key, and it is
 * org-scoped), so they see host fields — consistent with how the finance
 * redaction treats them.
 */

const ZOOM_HOST_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);

/** True when the role may see Zoom host credentials. Fails closed — an unknown
 *  or missing role gets `false`. Pass `isApiKey` for programmatic callers,
 *  which are admin-equivalent and carry a null role. */
export function canViewZoomHostCredentials(
  role: string | null | undefined,
  isApiKey = false,
): boolean {
  if (isApiKey) return true;
  return !!role && ZOOM_HOST_ROLES.has(role);
}

/** The fields on a ZoomMeeting payload that grant control rather than access. */
export const ZOOM_HOST_KEYS = ["startUrl", "streamKey", "passcode"] as const;

type ZoomHostKey = (typeof ZOOM_HOST_KEYS)[number];

/**
 * Strip host-only credentials from a session's `zoomMeeting` payload in place
 * of returning them. Returns a new object; the input is not mutated. Safe to
 * call on a session with no zoomMeeting.
 *
 * Keeps the key present but `null` rather than deleting it, so client code that
 * reads `zoomMeeting.startUrl` gets a falsy value instead of an undefined-shape
 * surprise — the same convention `redactFinancialFields` uses.
 */
export function redactZoomHostFields<
  T extends { zoomMeeting?: Partial<Record<ZoomHostKey, unknown>> | null },
>(session: T): T {
  if (!session.zoomMeeting) return session;
  const zoomMeeting = { ...session.zoomMeeting };
  for (const key of ZOOM_HOST_KEYS) {
    if (key in zoomMeeting) zoomMeeting[key] = null;
  }
  return { ...session, zoomMeeting };
}

/** Convenience for a list response. */
export function redactZoomHostFieldsFromSessions<
  T extends { zoomMeeting?: Partial<Record<ZoomHostKey, unknown>> | null },
>(sessions: T[]): T[] {
  return sessions.map(redactZoomHostFields);
}
