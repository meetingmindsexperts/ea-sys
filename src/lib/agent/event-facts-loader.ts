import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { EventFacts } from "@/lib/permissions/can";
import { eventFactsOf } from "@/lib/permissions/event-facts";
import { runWithTenant } from "@/lib/tenant-context";

/**
 * The facts the agent's tool gate judges an event-bound key by, for an event
 * in the caller's organisation. Null when there is no such event (the gate
 * then refuses, as the route would 404). A failed lookup logs and is null:
 * fail closed.
 */
export async function loadEventFacts(eventId: string, organizationId: string): Promise<EventFacts | null> {
  try {
    // Inside the caller's organisation's lane: the tool gate asks this before
    // any tool has entered one (Event RLS step 2).
    const event = await runWithTenant(organizationId, () =>
      db.event.findFirst({
        where: { id: eventId, organizationId },
        select: { organizationId: true, eventType: true, staffAssignments: { select: { userId: true } } },
      }),
    );
    if (!event) return null;
    return eventFactsOf({ ...event, staffUserIds: event.staffAssignments.map((a) => a.userId) });
  } catch (err) {
    apiLogger.error({ err, eventId, organizationId, msg: "agent:event-facts-failed" });
    return null;
  }
}
