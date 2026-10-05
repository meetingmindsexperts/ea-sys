import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { EventFacts } from "@/lib/permissions/can";
import { eventFactsOf } from "@/lib/permissions/event-facts";

/**
 * The facts the agent's tool gate judges an event-bound key by, for an event
 * in the caller's organisation. Null when there is no such event (the gate
 * then refuses, as the route would 404). A failed lookup logs and is null:
 * fail closed.
 */
export async function loadEventFacts(eventId: string, organizationId: string): Promise<EventFacts | null> {
  try {
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId },
      select: { organizationId: true, eventType: true, settings: true },
    });
    return eventFactsOf(event);
  } catch (err) {
    apiLogger.error({ err, eventId, organizationId, msg: "agent:event-facts-failed" });
    return null;
  }
}
