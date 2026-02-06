import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ eventId: string; registrationId: string }>;
}

export default async function RegistrationDetailPage({ params }: PageProps) {
  const { eventId } = await params;

  // Redirect to main registrations page - details are now shown in a side panel
  redirect(`/events/${eventId}/registrations`);
}
