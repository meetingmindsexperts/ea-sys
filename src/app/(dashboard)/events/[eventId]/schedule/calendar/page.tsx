import { redirect } from "next/navigation";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export default async function ScheduleCalendarRedirect({ params }: RouteParams) {
  const { eventId } = await params;
  redirect(`/events/${eventId}/schedule`);
}
