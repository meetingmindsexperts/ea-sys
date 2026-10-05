"use client";

import { useParams } from "next/navigation";
import { useEvent } from "@/hooks/use-api";
import { httpStatusOf } from "@/lib/session-expiry";
import { NoAccess } from "./no-access";

/**
 * An event the person cannot open (the event GET answers 404 or 403: not
 * assigned, another organisation, a conference for a webinar-only role) shows
 * the shared panel instead of a blank page behind a row of failed requests.
 * While the event loads, the page renders as before: no added wait.
 */
export function EventAccessGate({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const eventId = typeof params.eventId === "string" ? params.eventId : "";
  const event = useEvent(eventId);
  const code = event.error ? httpStatusOf(event.error) : undefined;
  if (code === 403 || code === 404) return <NoAccess what="this event" />;
  return <>{children}</>;
}
