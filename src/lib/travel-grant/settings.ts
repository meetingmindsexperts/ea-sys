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
 *
 * THE HOME COUNTRY IS PART OF THE SWITCH. `enabled: true` with no usable
 * `homeCountries` resolves to disabled, because an empty exempt set makes every
 * recognised country count as overseas — the feature would then offer a grant to
 * every local author. See `misconfigured` below.
 */

import { resolveCountryCode } from "@/lib/travel-grant/eligibility";

export interface TravelGrantSettings {
  /**
   * EFFECTIVE switch: does the feature actually run? False unless the organizer
   * set it to boolean true AND named at least one home country.
   */
  enabled: boolean;
  /**
   * ISO alpha-2 codes of the countries whose residents are NOT eligible —
   * usually the one the venue is in. Validated against the same country list
   * the picker renders, uppercased and deduplicated; anything unrecognised is
   * dropped rather than stored.
   */
  homeCountries: string[];
  /**
   * What the organizer ASKED for, ignoring whether it is usable. Distinct from
   * `enabled` on purpose, and the distinction is load-bearing in exactly one
   * place: an outstanding consent link must keep working while the organizer is
   * mid-edit on the country list.
   *
   * Residency only matters when a grant is MINTED — by the time a row exists,
   * that author was already judged eligible, and reading or answering their
   * form does not depend on the exempt list at all. So gating the public
   * consent route on `enabled` was too tight: emptying the list to change it
   * would kill every live link, and the author would see the same "invalid or
   * already used" message as a forged token, i.e. would conclude the offer had
   * been withdrawn. Refuse only when the organizer actually switched it OFF.
   *
   * The settings card's "on but doing nothing" warning is `switchedOn &&
   * !enabled` — derived at the one place that needs it rather than carried as a
   * third boolean.
   */
  switchedOn: boolean;
}

export const TRAVEL_GRANT_SETTINGS_DEFAULT: TravelGrantSettings = {
  enabled: false,
  homeCountries: [],
  switchedOn: false,
};

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
  const blob = raw as Record<string, unknown>;
  const switchedOn = blob.enabled === true;

  const homeCountries = Array.isArray(blob.homeCountries)
    ? [
        ...new Set(
          blob.homeCountries
            .map((v) => (typeof v === "string" ? resolveCountryCode(v) : null))
            .filter((code): code is string => !!code),
        ),
      ]
    : [];

  // §3.4 of the plan, and the ONE place here where the intuitive reading fails
  // OPEN. "Switched on, no country named" looks like it should mean "on", but
  // an empty exempt set classifies every recognised country as overseas — so
  // the feature would mail a grant offer to every local author, which is the
  // exact mistake it exists to prevent. On-but-unconfigured therefore means OFF.
  return {
    enabled: switchedOn && homeCountries.length > 0,
    homeCountries,
    switchedOn,
  };
}

/** Convenience for the many call sites that only need the boolean. */
export function isTravelGrantEnabled(settings: unknown): boolean {
  return readTravelGrantSettings(settings).enabled;
}
