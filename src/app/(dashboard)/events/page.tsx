import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Plus, Calendar, MapPin, Users, ArrowRight } from "lucide-react";
import { formatDateRange } from "@/lib/utils";
import { buildEventAccessWhere } from "@/lib/event-access";

const statusConfig: Record<
  string,
  { label: string; dotCls: string; pillCls: string; borderCls: string }
> = {
  DRAFT: {
    label: "Draft",
    dotCls: "bg-gray-400",
    pillCls: "bg-gray-100 text-gray-600 border-gray-200",
    borderCls: "border-t-gray-300",
  },
  PUBLISHED: {
    label: "Published",
    dotCls: "bg-primary",
    pillCls: "bg-blue-50 text-blue-700 border-blue-200",
    borderCls: "border-t-primary",
  },
  LIVE: {
    label: "Live",
    dotCls: "bg-green-500",
    pillCls: "bg-green-50 text-green-700 border-green-200",
    borderCls: "border-t-green-500",
  },
  COMPLETED: {
    label: "Completed",
    dotCls: "bg-purple-500",
    pillCls: "bg-purple-50 text-purple-700 border-purple-200",
    borderCls: "border-t-purple-400",
  },
  CANCELLED: {
    label: "Cancelled",
    dotCls: "bg-red-400",
    pillCls: "bg-red-50 text-red-600 border-red-200",
    borderCls: "border-t-red-400",
  },
};

export default async function EventsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const isRestricted =
    session.user.role === "REVIEWER" || session.user.role === "SUBMITTER";

  const events = await db.event.findMany({
    where: buildEventAccessWhere(session.user),
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { registrations: true, speakers: true } },
    },
  });

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
          <Button asChild className="btn-gradient shadow-sm">
            <Link href="/events/new">
              <Plus className="mr-2 h-4 w-4" />
              Create Event
            </Link>
          </Button>
        )}
      </div>

      {/* ── Event Grid ─────────────────────────────────────────────────────── */}
      {events.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {events.map((event) => {
            const sc = statusConfig[event.status] ?? statusConfig.DRAFT;
            return (
              <Link key={event.id} href={`/events/${event.id}`} className="group block">
                <div
                  className={`flex flex-col h-full rounded-xl border bg-card overflow-hidden transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/50 border-t-[3px] ${sc.borderCls}`}
                >
                  <div className="flex-1 p-5 space-y-3">
                    {/* Title + status pill */}
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-semibold text-base leading-snug line-clamp-2 group-hover:text-primary transition-colors">
                        {event.name}
                      </h3>
                      <span
                        className={`shrink-0 inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${sc.pillCls}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${sc.dotCls}`} />
                        {sc.label}
                      </span>
                    </div>

                    {/* Description */}
                    {event.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {event.description}
                      </p>
                    )}

                    {/* Meta: date + venue */}
                    <div className="space-y-1.5 text-sm text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <Calendar className="h-3.5 w-3.5 shrink-0 text-primary/60" />
                        <span>{formatDateRange(event.startDate, event.endDate)}</span>
                      </div>
                      {event.venue && (
                        <div className="flex items-center gap-2">
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-primary/60" />
                          <span className="truncate">{event.venue}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Footer strip */}
                  <div className="px-5 py-2.5 border-t bg-muted/20 flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Users className="h-3.5 w-3.5" />
                      <span>{event._count.registrations} registered</span>
                    </div>
                    <span className="text-xs text-primary font-medium flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      Open <ArrowRight className="h-3 w-3" />
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        /* ── Empty State ──────────────────────────────────────────────────── */
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
