/**
 * Who may be told an email's Cc and Bcc (review of 68ff2173, Nov 12, 2026).
 *
 * A Bcc is often an address the organisation keeps out of sight on purpose:
 * the accounts mailbox on a payment confirmation, an organiser's own "send me
 * a copy". The Activity timeline is opened with `registrations.read` or
 * `speakers.read`, which desk staff (ONSITE) and read-only staff (MEMBER)
 * hold, so the timeline hands the copies only to someone who also holds
 * `emailLogs.read`, the key the email history itself asks. Judged on the
 * event's own scope, so an assigned-only grant does not reach another event.
 */
import { can, type Principal } from "@/lib/permissions/can";
import { eventFactsOf } from "@/lib/permissions/event-facts";

export function emailCopiesVisibleFor(
  principal: Principal,
  event: { organizationId: string; eventType?: string | null; staffAssignments?: { userId: string }[] | null },
): boolean {
  const facts = eventFactsOf({ ...event, staffUserIds: (event.staffAssignments ?? []).map((a) => a.userId) });
  if (!facts) return false;
  return can(principal, "emailLogs.read", { event: facts });
}
