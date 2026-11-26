/**
 * THE rule for whether an event's public registration is closed (Nov 26, 2026).
 *
 * Closed, in this order:
 *  1. "switched-off": Settings, Registration, "Registration Open" is off (`settings.registrationOpen === false`).
 *  2. "closing-date-passed": the organiser's "Close registration on" date has passed
 *     (`settings.registrationClosesAt`, an ISO instant).
 *  3. "webinar-over": a WEBINAR whose room has ended, by the room's own rule (`webinarRoomEnded`:
 *     never while live, past the scheduled end, or closed by the producer from the scheduled start
 *     on). A webinar with no session of its own goes by the event's end. Owner, Nov 26, 2026:
 *     close outright, whatever the recording switch says. Six people registered for MENA
 *     HemeConnect Wave 1 after its room closed and were sent a join link to a closed room.
 *
 * Every public door asks this (the register and group register routes, the public event API that
 * the register pages and the abstract sign-up read, the event page, the catalogue, the desk QR, the
 * presenter rates). Staff adding a registration from the dashboard are exempt, as before.
 * **Never read `settings.registrationOpen` anywhere else** (`registration-closure-readers.test.ts`
 * lists the files that may). The server side, which loads the webinar's session, is
 * `registration-closure-server.ts`. Pure and client-safe.
 */
import { z } from "zod";
import { webinarRoomEnded } from "@/lib/webinar-page-layout";

export type RegistrationClosedReason = "switched-off" | "closing-date-passed" | "webinar-over";

/** The settings key the close date is stored under. Not copied by a clone (event-clone-settings.ts). */
export const REGISTRATION_CLOSES_AT_SETTING = "registrationClosesAt";

/** What the event save accepts for the close date: a full ISO instant with its offset, or empty. */
export const registrationClosesAtSchema = z.union([z.string().datetime({ offset: true }), z.null(), z.literal("")]);

/** The anchor session's clock, as the room rule reads it. */
export interface AnchorSessionClock {
  status: string;
  startTime: Date;
  endTime: Date;
}

export interface ClosureEvent {
  eventType: string | null | undefined;
  settings: unknown;
  endDate: Date;
}

function record(settings: unknown): Record<string, unknown> {
  return settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
}

/** The organiser's close date, or null when none is set or the stored value is not a date. */
export function readRegistrationClosesAt(settings: unknown): Date | null {
  const raw = record(settings)[REGISTRATION_CLOSES_AT_SETTING];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The organiser's own two controls: the switch and the close date. Enough on its own only for a
 * door that never serves a webinar (the abstract sign-up: abstract-intake.ts never opens one).
 */
export function settingsClosedReason(settings: unknown, now: Date = new Date()): RegistrationClosedReason | null {
  if (record(settings).registrationOpen === false) return "switched-off";
  const closesAt = readRegistrationClosesAt(settings);
  if (closesAt && now.getTime() >= closesAt.getTime()) return "closing-date-passed";
  return null;
}

/** A webinar is over by its room's rule; one with no session of its own, by the event's end. */
export function webinarRegistrationOver(event: ClosureEvent, anchor: AnchorSessionClock | null, now: Date): boolean {
  if (event.eventType !== "WEBINAR") return false;
  if (!anchor) return event.endDate.getTime() < now.getTime();
  return webinarRoomEnded({
    status: anchor.status,
    startMs: anchor.startTime.getTime(),
    endMs: anchor.endTime.getTime(),
    now: now.getTime(),
  });
}

/**
 * Why public registration is closed, or null when it is open. `anchor` is the webinar's own
 * session (null for any other event, or a webinar without one).
 */
export function registrationClosedReason(
  event: ClosureEvent,
  anchor: AnchorSessionClock | null,
  now: Date = new Date(),
): RegistrationClosedReason | null {
  return settingsClosedReason(event.settings, now) ?? (webinarRegistrationOver(event, anchor, now) ? "webinar-over" : null);
}

/**
 * The reminder the event Overview shows staff (owner, Nov 26, 2026: "add a reminder for the organiser
 * to close registration or set up a closing date and time"). Null when there is nothing to remind:
 * a webinar (it closes itself), an event the public cannot reach (draft, completed, cancelled), or
 * registration already closed by the switch or a passed date.
 *  - "ended-still-open": the event has ended and its public form still takes registrations.
 *  - "no-close-date": a live event with no close date set.
 */
export type RegistrationCloseReminder = "ended-still-open" | "no-close-date";

export function registrationCloseReminder(
  event: ClosureEvent & { status: string },
  now: Date = new Date(),
): RegistrationCloseReminder | null {
  if (event.eventType === "WEBINAR") return null;
  if (event.status !== "PUBLISHED" && event.status !== "LIVE") return null;
  if (settingsClosedReason(event.settings, now)) return null;
  if (event.endDate.getTime() < now.getTime()) return "ended-still-open";
  return readRegistrationClosesAt(event.settings) ? null : "no-close-date";
}

/**
 * Whether this reason also closes the onsite desk's walk-in QR. The close date closes online
 * sign-up only (owner, Nov 26, 2026: "online registration closes Dec 1, the event is Dec 5", and
 * walk-ins still register at the venue by the desk QR, as it already does for a rate whose sales
 * window has ended). The switch closes everything; a webinar has no desk.
 */
export function closesTheDesk(reason: RegistrationClosedReason): boolean {
  return reason !== "closing-date-passed";
}

/** What a door answers when it refuses. */
export function registrationClosedMessage(reason: RegistrationClosedReason): string {
  if (reason === "webinar-over") return "This webinar has ended, so registration is closed.";
  return "Registration is closed for this event.";
}
