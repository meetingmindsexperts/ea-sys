import { redirect } from "next/navigation";

/**
 * Legacy path — My Details moved to the neutral /events/[eventId]/my-details
 * (owner request Aug 5, 2026: a session-proposal submitter must not see
 * "abstracts" in their profile URL; the page serves BOTH flows). Kept as a
 * permanent redirect so old bookmarks and emailed links keep working.
 */
export default async function LegacyAbstractProfileRedirect({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  redirect(`/events/${eventId}/my-details`);
}
