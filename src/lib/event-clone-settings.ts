/**
 * Which `Event.settings` keys copy when an event is cloned.
 *
 * ALLOW-LIST, not a deny-list — this is the whole point. The clone route used
 * to spread `settings` wholesale and blank out only `reviewerUserIds`. A
 * deny-list goes stale the next time someone adds a settings key, which is
 * exactly how cloning a WEBINAR event broke: the clone inherited
 * `settings.webinar.sessionId` pointing at the SOURCE event's anchor session,
 * so `webinarSecondRoomViolation` then 409'd (WEBINAR_ANCHOR_ONLY) on every Zoom
 * attach, naming a session that does not exist on the clone.
 *
 * A key NOT on the allow-list is dropped. That is the correct failure mode: a
 * clone missing a freshly-added config key is recoverable (add the key here),
 * whereas a clone carrying stale per-instance state/identity is a bug the
 * organizer discovers in production.
 *
 * SCOPE NOTE: this preserves the existing clone contract for every key the old
 * wholesale copy carried (publish flags, deadlines, all config — clone.test.ts
 * pins that agendaPublished is preserved, and whether a cloned+published event
 * re-publishes its agenda is a product decision, not this fix's to flip). The
 * only behavioural changes vs the old deny-list are: (1) the webinar anchor
 * identity/state sub-keys are dropped (the bug), (2) `onsiteUserIds` joins
 * `reviewerUserIds` in being reset to [] — both are per-event STAFF ASSIGNMENTS
 * and a clone starts with neither, and (3) an unrecognised future key is
 * dropped rather than silently carried.
 */

/** Top-level config keys copied verbatim onto a clone. */
const CLONEABLE_SETTINGS_KEYS: readonly string[] = [
  // Registration behaviour
  "requireApproval",
  "waitlistEnabled",
  "registrationOpen",
  "showRemainingTickets",
  "maxAttendees",
  "groupRegistration",
  "presenterRegistration",
  // Abstracts / review config + the date-specific deadlines (preserved — the
  // old copy carried them; whether a clone wants fresh dates is the organizer's
  // edit, not ours to force by dropping them).
  "allowAbstractSubmissions",
  "abstractPresentationTypes",
  "abstractLimits",
  "requiredReviewCount",
  "abstractDeadline",
  "sessionProposalDeadline",
  // Publish flags — preserved (clone.test.ts pins this; gated by event.status
  // which the clone resets to DRAFT anyway).
  "agendaPublished",
  "programmePublished",
  // Notifications
  "notifyOnRegistration",
  "notifyOnAbstractSubmission",
  "notifyOnSessionCreated",
  "emailNotifications",
  // Content / operations config
  // "sponsors" was here until Sep 2 2026, when sponsors became a table. It is
  // NOT re-added: the clone route copies Sponsor ROWS directly, and leaving the
  // key would have the clone carry a stale JSON copy alongside the real rows,
  // which is the two-sources-of-truth state the promotion exists to end.
  "cme",
  "badge",
  "travelGrant",
  "zoom",
  // Legacy but harmless carried config
  "certificateTemplates",
  "residentLetter",
];

/**
 * Webinar CONFIG sub-keys that copy. The anchor identity/state sub-keys
 * (sessionId, autoCreated, provisioningAt) are DROPPED — that is the bug this
 * whole module exists to fix. The clone provisions its OWN anchor (run the
 * webinar provisioner on the clone from the console).
 */
const CLONEABLE_WEBINAR_KEYS: readonly string[] = [
  "autoProvisionZoom",
  "autoRecording",
  "automationEnabled",
  "waitingRoom",
  "viewingMode",
  "lobbyVideoUrl",
  "lobbyMessage",
  "lobbyImageUrl",
  "defaultMeetingType",
];

/**
 * Build the settings JSON for a cloned event from the source event's settings.
 * Pure — no I/O. Returns a plain object safe to hand to Prisma's Json column.
 */
export function cloneEventSettings(source: unknown): Record<string, unknown> {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const src = source as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of CLONEABLE_SETTINGS_KEYS) {
    if (key in src && src[key] !== undefined) out[key] = src[key];
  }

  // Webinar: copy CONFIG only, never the anchor identity/state.
  const webinar = src.webinar;
  if (webinar && typeof webinar === "object" && !Array.isArray(webinar)) {
    const srcWebinar = webinar as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const key of CLONEABLE_WEBINAR_KEYS) {
      if (key in srcWebinar && srcWebinar[key] !== undefined) cleaned[key] = srcWebinar[key];
    }
    if (Object.keys(cleaned).length > 0) out.webinar = cleaned;
  }

  // Staff assignments never carry to a clone — it starts with an empty reviewer
  // pool and no onsite staff. Emitted explicitly (not just dropped) to preserve
  // the reviewerUserIds:[] shape every clone has always had.
  out.reviewerUserIds = [];
  out.onsiteUserIds = [];

  return out;
}
