/**
 * The event's online venue rooms (docs/EVENT_BLUEPRINT_PLAN.md, D9): the room
 * list the walkable venue is built from. Reached from the Event Setup hub.
 * Not found while VENUE_MODULE_ENABLED is off.
 */
import { notFound } from "next/navigation";
import { isVenueModuleEnabled } from "@/lib/module-flags";
import { VenueRoomsEditor } from "@/components/venue/venue-rooms-editor";

export default async function VenuePage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  if (!isVenueModuleEnabled()) notFound();
  return <VenueRoomsEditor eventId={eventId} />;
}
