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
      select: { organizationId: true, eventType: true, settings: true, staffAssignments: { select: { userId: true } } },
    });
    const facts = eventFactsOf(event);
    if (!facts || !event) return facts;
    // Assigned staff from either store during the Phase 4 transition.
    const staff = new Set([...(facts.staffUserIds ?? []), ...(event.staffAssignments ?? []).map((a) => a.userId)]);
    return { ...facts, staffUserIds: [...staff] };
  } catch (err) {
    apiLogger.error({ err, eventId, organizationId, msg: "agent:event-facts-failed" });
    return null;
  }
}
