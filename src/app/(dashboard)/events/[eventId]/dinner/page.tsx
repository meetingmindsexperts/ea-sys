import { redirect } from "next/navigation";

/**
 * LEGACY — the Dinner RSVP console lived here until Aug 14, 2026, when an event
 * gained the ability to run SEVERAL RSVPs (docs/CUSTOMIZABLE_RSVP_PLAN.md).
 * Kept as a permanent redirect because organizers have this URL bookmarked
 * (the same treatment `/abstracts/profile` → `/my-details` got).
 */
export default async function DinnerRsvpRedirect({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  redirect(`/events/${eventId}/rsvp`);
}
