"use client";

import { useParams, usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useSession } from "next-auth/react";
import { useEvent } from "@/hooks/use-api";
import { eventFactsOf } from "@/hooks/use-can";
import { httpStatusOf } from "@/lib/session-expiry";
import { can, principalFromUser } from "@/lib/permissions/can";
import { EVENT_PAGE_KEYS, eventPageSegment } from "@/lib/permissions/event-page-keys";
import { NoAccess } from "./no-access";

/**
 * Every event page (owner, Oct 5, 2026):
 *  - an event the person cannot open (the event GET answers 404 or 403: not
 *    assigned, another organisation, a conference for a webinar-only role)
 *    shows the shared panel instead of a blank page;
 *  - a page whose key (`EVENT_PAGE_KEYS`) the person does not hold for this
 *    event shows it too, and the page never mounts, so it fires no requests.
 * A page in `EVENT_PAGE_KEYS` waits for the event (normally cached by the
 * sidebar); any other page renders while it loads. The outside identities (reviewer, submitter) work in no area and are left to
 * their own guards. Advisory: the routes decide.
 */
export function EventAccessGate({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const pathname = usePathname();
  const { data: session } = useSession();
  const eventId = typeof params.eventId === "string" ? params.eventId : "";
  const event = useEvent(eventId);

  const code = event.error ? httpStatusOf(event.error) : undefined;
  if (code === 403 || code === 404) return <NoAccess what="this event" />;

  const key = EVENT_PAGE_KEYS[eventPageSegment(pathname)];
  if (!key || !session?.user) return <>{children}</>;
  const p = principalFromUser(session.user);
  if (p.areas.length === 0) return <>{children}</>;
  // A gated page waits for the event (usually already cached by the sidebar),
  // so a page the person cannot use never mounts and never fires its requests.
  const facts = eventFactsOf(event.data);
  if (!facts) {
    if (event.error) return <>{children}</>;
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }
  if (can(p, key, { event: facts })) return <>{children}</>;
  return <NoAccess what="this page" back={{ href: `/events/${eventId}`, label: "Back to the event" }} />;
}
