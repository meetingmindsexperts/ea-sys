import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Calendar, MapPin, Users } from "lucide-react";
import { formatDateRange } from "@/lib/utils";
import { buildEventAccessWhere } from "@/lib/event-access";

const statusColors = {
  DRAFT: "bg-gray-100 text-gray-800",
  PUBLISHED: "bg-blue-100 text-blue-800",
  LIVE: "bg-green-100 text-green-800",
  COMPLETED: "bg-purple-100 text-purple-800",
  CANCELLED: "bg-red-100 text-red-800",
};

export default async function EventsPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  const isReviewer = session.user.role === "REVIEWER";

  const events = await db.event.findMany({
    where: buildEventAccessWhere(session.user),
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: {
          registrations: true,
          speakers: true,
        },
      },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Events</h1>
          <p className="text-muted-foreground">
            Manage all your events in one place
          </p>
        </div>
        {!isReviewer && (
          <Button asChild>
            <Link href="/events/new">
              <Plus className="mr-2 h-4 w-4" />
              Create Event
            </Link>
          </Button>
        )}
      </div>

      {events.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {events.map((event) => (
            <Link key={event.id} href={`/events/${event.id}`}>
              <Card className="hover:border-primary transition-colors cursor-pointer h-full">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle className="line-clamp-1">
                        {event.name}
                      </CardTitle>
                      <CardDescription className="line-clamp-2">
                        {event.description || "No description"}
                      </CardDescription>
                    </div>
                    <Badge
                      className={statusColors[event.status]}
                      variant="outline"
                    >
                      {event.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Calendar className="h-4 w-4" />
                    {formatDateRange(event.startDate, event.endDate)}
                  </div>
                  {event.venue && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-4 w-4" />
                      {event.venue}
                    </div>
                  )}
                  <div className="flex items-center gap-4 pt-2 border-t">
                    <div className="flex items-center gap-1 text-sm">
                      <Users className="h-4 w-4" />
                      {event._count.registrations} registrations
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Calendar className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No events yet</h3>
            <p className="text-muted-foreground mb-4 text-center">
              {isReviewer
                ? "You have no assigned events yet."
                : "Create your first event to start managing registrations, speakers, and more."}
            </p>
            {!isReviewer && (
              <Button asChild>
                <Link href="/events/new">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Event
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
