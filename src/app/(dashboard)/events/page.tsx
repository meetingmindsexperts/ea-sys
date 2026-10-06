import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { Button } from "@/components/ui/button";
import { Plus, Calendar } from "lucide-react";
import { eventListWhere } from "@/lib/permissions/page-event-where";
import { eventListSelect } from "@/lib/event-visibility";
import { EventListClient } from "./event-list-client";
import { EventsAirImportButton } from "@/components/import/eventsair-import-button";
import { can } from "@/lib/permissions/can";
import { principalFromSession } from "@/lib/permissions/require-permission";
import { eventOrderBy, parseEventSort } from "@/lib/event-sort";

interface EventsPageProps {
  searchParams: Promise<{ sort?: string | string[]; order?: string | string[] }>;
}

export default async function EventsPage({ searchParams }: EventsPageProps) {
  const [session, sp] = await Promise.all([auth(), searchParams]);
  if (!session?.user) redirect("/login");

  const isRestricted =
    session.user.role === "REVIEWER" || session.user.role === "SUBMITTER";

  // The import lists EventsAir events with the organisation's credentials, so
  // it is offered only to who holds both (an organiser holds the import key
  // but not the credentials, and its dialog could never list anything).
  const principal = principalFromSession(session);
  const canImportFromEventsAir = can(principal, "imports.eventsair") && can(principal, "org.credentials");
  const canCreateEvent = can(principal, "events.create");

  const sort = parseEventSort(sp);

  let events;
  try {
    // Explicit select, and NO headcounts for an org-null role: a reviewer or an
    // abstract submitter has no remit over who registered, so the numbers are
    // never fetched rather than fetched and hidden. See `eventListSelect`.
    events = await db.event.findMany({
      // Desk surface, matching `GET /api/events`. The two had drifted: the API
      // passed it, this page did not, so a WEBINARS user's assigned events were
      // returned by the endpoint but missing from the page that renders the
      // list. Same query, same flag — the list is one thing, not two.
      where: eventListWhere(session, "events:page"),
      orderBy: eventOrderBy(sort),
      select: eventListSelect(session.user.role),
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to load events list", userId: session.user.id });
    throw error;
  }

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Events</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {isRestricted
              ? "Events assigned to you"
              : `${events.length} event${events.length !== 1 ? "s" : ""} in your workspace`}
          </p>
        </div>
        {!isRestricted && (
          <div className="flex gap-2">
            {canImportFromEventsAir && <EventsAirImportButton />}
            {canCreateEvent && (
              <Button asChild className="btn-gradient shadow-sm">
                <Link href="/events/new">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Event
                </Link>
              </Button>
            )}
          </div>
        )}
      </div>

      {/* ── Events ─────────────────────────────────────────────────────────── */}
      {events.length > 0 ? (
        <EventListClient
          events={JSON.parse(JSON.stringify(events))}
          isRestricted={isRestricted}
          isWebinarStaff={session.user.role === "WEBINARS"}
          sortField={sort.field}
          sortOrder={sort.order}
        />
      ) : (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
            <Calendar className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-lg font-semibold mb-1">No events yet</h3>
          <p className="text-muted-foreground text-sm max-w-xs mb-5">
            {isRestricted && "You have no assigned events yet."}
            {!isRestricted && canCreateEvent && "Create your first event to start managing registrations, speakers, and more."}
            {!isRestricted && !canCreateEvent && "There are no events in your workspace yet."}
          </p>
          {!isRestricted && canCreateEvent && (
            <Button asChild className="btn-gradient shadow-sm">
              <Link href="/events/new">
                <Plus className="mr-2 h-4 w-4" />
                Create Event
              </Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
