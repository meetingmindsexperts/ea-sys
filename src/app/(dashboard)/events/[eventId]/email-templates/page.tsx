"use client";

import { useParams, redirect } from "next/navigation";

export default function EmailTemplatesRedirect() {
  const params = useParams();
  const eventId = params.eventId as string;
  redirect(`/events/${eventId}/communications/templates`);
}
