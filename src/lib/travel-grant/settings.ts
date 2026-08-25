/**
 * Per-event Travel Grant configuration.
 *
 * Stored in `Event.settings.travelGrant` as plain JSON, so there is no
 * migration and no column. Same escape hatch as `abstractLimits`,
 * `sessionProposalDeadline`, `agendaPublished` and `registrationOpen`.
 *
 * WHY ITS OWN MODULE, in the `travel-grant/` folder rather than beside the
 * server code that uses it: the Settings page is a client component, so
 * anything it imports must not drag `db` or a Node built-in into the browser
 * bundle, where it resolves to `undefined` and fails silently at click time.
 * Pure data and pure functions only.
 *
 * WHY THE DEFAULT IS OFF, AND WHY THE CHECK IS `=== true`.
 * This flag decides whether we EMAIL people. Every other reader in this
 * codebase that governs a destructive-if-wrong action fails closed, and this
 * one has to as well: an absent key, a corrupted blob, a string `"true"`, a
 * `1`, or a half-written settings object must all resolve to disabled. The
 * opposite direction would mean a malformed JSON blob starts mailing grant
 * offers to an event's authors, which is not recoverable by editing the blob
 * afterwards. `showRemainingTickets` uses the same strict opt-in for the same
 * reason.
 *
 * The inverse rule applies to `registrationOpen`, which defaults ON because a
 * missing key there would close registration on every existing event. The
 * direction is chosen per flag by asking which mistake is cheaper, not by
 * habit.
 */

export interface TravelGrantSettings {
  /** Master switch. Off unless explicitly and correctly set to boolean true. */
  enabled: boolean;
}

export const TRAVEL_GRANT_SETTINGS_DEFAULT: TravelGrantSettings = { enabled: false };

/**
 * Read the travel-grant config off an event's `settings` JSON.
 *
 * Never throws. Any shape that is not exactly `{ travelGrant: { enabled: true } }`
 * resolves to disabled, including `null`, an array, a string, a nested `"true"`,
 * and a settings object with no `travelGrant` key at all.
 */
export function readTravelGrantSettings(settings: unknown): TravelGrantSettings {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return TRAVEL_GRANT_SETTINGS_DEFAULT;
  }
  const raw = (settings as Record<string, unknown>).travelGrant;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return TRAVEL_GRANT_SETTINGS_DEFAULT;
  }
  return { enabled: (raw as Record<string, unknown>).enabled === true };
}

/** Convenience for the many call sites that only need the boolean. */
export function isTravelGrantEnabled(settings: unknown): boolean {
  return readTravelGrantSettings(settings).enabled;
}
