"use client";

import { useParams, redirect } from "next/navigation";

export default function EmailTemplateEditorRedirect() {
  const params = useParams();
  const eventId = params.eventId as string;
  const templateId = params.templateId as string;
  redirect(`/events/${eventId}/communications/templates/${templateId}`);
}
