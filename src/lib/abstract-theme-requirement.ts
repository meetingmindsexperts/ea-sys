/**
 * Theme is mandatory to SUBMIT an abstract — when the event actually has themes
 * (owner, Aug 7, 2026).
 *
 * The conditional half matters: themes are per-event and optional, so a blanket
 * requirement would make submission impossible on an event whose organiser
 * never created any. The rule is therefore "if the event offers themes, pick
 * one", which mirrors how the presentation-type requirement behaves.
 *
 * A DRAFT can be saved without one, same as presentation type — the gate is on
 * submitting, not on keeping notes.
 *
 * Pure so both sides can use it: the forms pass `themes.length > 0` from the
 * list they already fetched, the routes pass a COUNT query. One rule, one
 * message, no chance of the form and the server disagreeing about what is
 * required.
 */

export const THEME_REQUIRED_CODE = "THEME_REQUIRED";
export const THEME_REQUIRED_MESSAGE = "Please choose a theme for your abstract.";

export function isThemeMissing(
  eventHasThemes: boolean,
  themeId: string | null | undefined,
): boolean {
  return eventHasThemes && !themeId?.trim();
}

export const SUB_THEME_REQUIRED_CODE = "SUB_THEME_REQUIRED";
export const SUB_THEME_REQUIRED_MESSAGE =
  "Please choose a sub-theme for the theme you selected.";

/**
 * Sub-theme follows the SAME conditional shape one level down: required only
 * when the CHOSEN THEME has sub-themes. A theme with none submits exactly as it
 * did before this existed, which is what keeps the feature optional for
 * organisers who do not want it.
 *
 * Deliberately keyed on the chosen theme's children rather than on "does the
 * event have any sub-themes anywhere" — otherwise adding sub-themes to one
 * theme would start demanding them on every other theme too.
 */
export function isSubThemeMissing(
  chosenThemeHasSubThemes: boolean,
  subThemeId: string | null | undefined,
): boolean {
  return chosenThemeHasSubThemes && !subThemeId?.trim();
}
