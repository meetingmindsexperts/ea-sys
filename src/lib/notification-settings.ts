/**
 * Which admin notifications an event is allowed to send.
 *
 * Stored per event in `Event.settings` as plain booleans. No migration, same
 * escape hatch as `agendaPublished` / `registrationOpen` / `abstractLimits`.
 *
 * WHY ITS OWN MODULE. `notifications.ts` imports `db` and the push client, so
 * the Settings page (a client component) cannot import from it without pulling
 * Prisma into the browser bundle, where it resolves to `undefined` and fails
 * silently at click time. The alternative is one copy of the key list in the UI
 * and another in the server gate, which is exactly the cross-caller duplication
 * that lets the two drift. This file is pure data plus one pure function, safe
 * on both sides.
 *
 * HISTORY WORTH KNOWING. `notifyOnRegistration` and `notifyOnAbstractSubmission`
 * shipped as UI switches that saved correctly and were **read by nothing**. An
 * organizer switching one off got a success toast and kept receiving the
 * notifications; on prod one event had both set to false and was still being
 * notified. A flag that is displayed but not enforced is worse than no flag,
 * because it silently spends the trust of the person who set it. They are
 * enforced from Aug 17, 2026, when `notifyOnSessionCreated` was added.
 */

export const NOTIFICATION_SETTING_KEYS = [
  "notifyOnRegistration",
  "notifyOnAbstractSubmission",
  "notifyOnSessionCreated",
] as const;

export type NotificationSettingKey = (typeof NOTIFICATION_SETTING_KEYS)[number];

/** Copy for the Settings → General → Notifications panel. */
export const NOTIFICATION_SETTING_LABELS: Record<
  NotificationSettingKey,
  { label: string; description: string }
> = {
  notifyOnRegistration: {
    label: "New Registration Notifications",
    description: "When someone registers, including group and bulk additions.",
  },
  notifyOnAbstractSubmission: {
    label: "Abstract Submission Notifications",
    description: "When an abstract is submitted or resubmitted.",
  },
  notifyOnSessionCreated: {
    label: "Session Created Notifications",
    description: "When a session is added to the agenda.",
  },
};

/** Every switch defaults ON, so an event that predates a key keeps behaving as it did. */
export const DEFAULT_NOTIFICATION_SETTINGS: Record<NotificationSettingKey, boolean> =
  Object.fromEntries(NOTIFICATION_SETTING_KEYS.map((k) => [k, true])) as Record<
    NotificationSettingKey,
    boolean
  >;

/**
 * True when the event permits this notification.
 *
 * Fails OPEN, deliberately: only an explicit `false` suppresses. Absent, null,
 * a corrupt settings blob or a value of the wrong type all mean "send it".
 * A missed notification is invisible to the person who needed it, whereas one
 * they did not want is merely noise, so the safe direction is to send.
 */
export function isNotificationEnabled(
  settings: unknown,
  key: NotificationSettingKey,
): boolean {
  if (!settings || typeof settings !== "object") return true;
  return (settings as Record<string, unknown>)[key] !== false;
}
