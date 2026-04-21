import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { Button } from "@/components/ui/button";
import { Plus, Calendar } from "lucide-react";
import { buildEventAccessWhere } from "@/lib/event-access";
import { EventListClient } from "./event-list-client";
import { EventsAirImportButton } from "@/components/import/eventsair-import-button";
import { eventOrderBy, parseEventSort } from "@/lib/event-sort";

interface EventsPageProps {
  searchParams: Promise<{ sort?: string | string[]; order?: string | string[] }>;
}

export default async function EventsPage({ searchParams }: EventsPageProps) {
  const [session, sp] = await Promise.all([auth(), searchParams]);
  if (!session?.user) redirect("/login");

  const isRestricted =
    session.user.role === "REVIEWER" || session.user.role === "SUBMITTER";

  const sort = parseEventSort(sp);

  let events;
  try {
    events = await db.event.findMany({
      where: buildEventAccessWhere(session.user),
      orderBy: eventOrderBy(sort),
      include: {
        _count: { select: { registrations: true, speakers: true } },
      },
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
            <EventsAirImportButton />
            <Button asChild className="btn-gradient shadow-sm">
              <Link href="/events/new">
                <Plus className="mr-2 h-4 w-4" />
                Create Event
              </Link>
            </Button>
          </div>
        )}
      </div>

      {/* ── Events ─────────────────────────────────────────────────────────── */}
      {events.length > 0 ? (
        <EventListClient
          events={JSON.parse(JSON.stringify(events))}
          isRestricted={isRestricted}
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
            {isRestricted
              ? "You have no assigned events yet."
              : "Create your first event to start managing registrations, speakers, and more."}
          </p>
          {!isRestricted && (
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
