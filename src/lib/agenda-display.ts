/**
 * How the public agenda page looks, per event (`Event.settings`).
 *
 * `agendaTrackBorder`: whether each session card carries a 4px left border in
 * its track's colour. ON unless an organiser switched it off (Settings, Agenda),
 * because that is how every agenda looked before the switch existed. An event
 * whose tracks all share one colour (MEHFC 2027: four halls, one brand red) gets
 * a wall of identical bars that say nothing and outshout the programme, so the
 * organiser can turn it off; the track colour then shows only as a dot: beside
 * the track name on a card, and beside the column heading (the track's name) in
 * a block of parallel sessions, whose cards carry no track line of their own.
 */

export const AGENDA_TRACK_BORDER_SETTING = "agendaTrackBorder";

/** True unless the setting is explicitly `false`: a missing or odd value keeps the border. */
export function readAgendaTrackBorder(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return true;
  return (settings as Record<string, unknown>)[AGENDA_TRACK_BORDER_SETTING] !== false;
}
