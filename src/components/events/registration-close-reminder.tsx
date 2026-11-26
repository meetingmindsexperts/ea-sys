/**
 * The event Overview's reminder to close registration (owner, Nov 26, 2026: "add a reminder for the
 * organiser to close registration or set up a closing date and time"). Which one, if any, is
 * `registrationCloseReminder` in registration-closure.ts; this words it and decides who sees it
 * (closeReminderFor: whoever may change the event's settings, since the fix is there). A webinar never gets one: it closes itself.
 */
import Link from "next/link";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { can, type Principal } from "@/lib/permissions/can";
import { eventFactsOf } from "@/lib/permissions/event-facts";
import {
  registrationCloseReminder,
  type ClosureEvent,
  type RegistrationCloseReminder,
} from "@/lib/registration-closure";

/**
 * The reminder this person should see, or null. Only someone who can make the fix: changing the
 * switch or the date is an `events.settings` change (field-permissions.ts), not `events.update`
 * (review of bd05639aa). `staffUserIds` lets a grant scoped to assigned events count.
 */
export function closeReminderFor(
  principal: Principal,
  event: ClosureEvent & { status: string; organizationId: string; staffUserIds: readonly string[] },
  now: Date = new Date(),
): RegistrationCloseReminder | null {
  if (!can(principal, "events.settings", { event: eventFactsOf(event) })) return null;
  return registrationCloseReminder(event, now);
}

export function RegistrationCloseReminderNotice({
  reminder,
  eventId,
}: {
  reminder: RegistrationCloseReminder;
  eventId: string;
}) {
  const ended = reminder === "ended-still-open";
  const Icon = ended ? AlertTriangle : CalendarClock;
  return (
    <div
      role="status"
      className={
        ended
          ? "flex flex-wrap items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          : "flex flex-wrap items-start gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200"
      }
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        {ended ? (
          <>
            <strong>This event has ended, and public registration is still open.</strong>{" "}
            Switch Registration Open
            off, or set the close date to a time already passed, so nobody registers for an event that is over.
          </>
        ) : (
          <>
            <strong>Registration has no closing date.</strong>{" "}
            Set &ldquo;Close registration on&rdquo; so the
            online form closes by itself, or switch Registration Open off when you are done. The desk&apos;s
            walk-in QR keeps working after the date.
          </>
        )}
      </p>
      <Link
        href={`/events/${eventId}/settings?tab=registration`}
        className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
      >
        Settings, Registration
      </Link>
    </div>
  );
}
