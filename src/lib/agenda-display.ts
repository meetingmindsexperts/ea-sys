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

/**
 * Whether the organiser switched the agenda on (Settings, Agenda;
 * `programmePublished` is the old name). Strictly `true`: every stored value on
 * production is a boolean (checked Nov 17, 2026), and a stray string must not
 * publish a programme. The one rule for the agenda route, the event API and
 * the event page.
 */
export function isAgendaPublished(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const s = settings as Record<string, unknown>;
  return s.agendaPublished === true || s.programmePublished === true;
}

/** The event statuses whose agenda the public can open (with the switch on). */
export const AGENDA_PUBLIC_EVENT_STATUSES = ["PUBLISHED", "LIVE"] as const;

/** Whether attendees can open the agenda right now: the switch AND a public event. */
export function isAgendaLiveForAttendees(settings: unknown, eventStatus: string): boolean {
  return (
    isAgendaPublished(settings) &&
    (AGENDA_PUBLIC_EVENT_STATUSES as readonly string[]).includes(eventStatus)
  );
}

/** True unless the setting is explicitly `false`: a missing or odd value keeps the border. */
export function readAgendaTrackBorder(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return true;
  return (settings as Record<string, unknown>)[AGENDA_TRACK_BORDER_SETTING] !== false;
}
