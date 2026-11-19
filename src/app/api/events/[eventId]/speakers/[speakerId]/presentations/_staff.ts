/**
 * The speaker a staff presentation route is about (Nov 19, 2026): on an
 * event the caller's grant reaches, a speaker of that event. Each route
 * checks the sign-in and the permission and enters the tenant lane itself;
 * this is the one lookup the four routes beside it share.
 */
import { db } from "@/lib/db";
import { findGatedEvent, type EventGate } from "@/lib/tenant/event-tenant";

export interface StaffSpeakerScope {
  eventId: string;
  organizationId: string;
  speakerId: string;
}

/** Null when the event is outside the grant or the speaker is not on it. Call inside the lane. */
export async function loadStaffSpeaker(gate: EventGate, eventId: string, speakerId: string): Promise<StaffSpeakerScope | null> {
  const event = await findGatedEvent(gate, { select: { id: true, organizationId: true } });
  if (!event) return null;
  const speaker = await db.speaker.findFirst({ where: { id: speakerId, eventId }, select: { id: true } });
  return speaker ? { eventId, organizationId: event.organizationId, speakerId } : null;
}
