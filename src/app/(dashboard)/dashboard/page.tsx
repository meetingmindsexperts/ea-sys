import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Calendar, Users, Ticket, TrendingUp } from "lucide-react";

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  // Reviewers and submitters have no org dashboard — redirect to events list
  if (session.user.role === "REVIEWER" || session.user.role === "SUBMITTER") {
    redirect("/events");
  }

  const [eventCount, registrationCount, recentEvents] = await Promise.all([
    db.event.count({
      where: { organizationId: session.user.organizationId! },
    }),
    db.registration.count({
      where: {
        event: { organizationId: session.user.organizationId! },
      },
    }),
    db.event.findMany({
      where: { organizationId: session.user.organizationId! },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        _count: {
          select: { registrations: true },
        },
      },
    }),
  ]);

  const stats = [
    {
      title: "Total Events",
      value: eventCount,
      icon: Calendar,
      description: "Active and completed",
    },
    {
      title: "Total Registrations",
      value: registrationCount,
      icon: Users,
      description: "Across all events",
    },
    {
      title: "Tickets Sold",
      value: registrationCount,
      icon: Ticket,
      description: "This month",
    },
    {
      title: "Revenue",
      value: "$0",
      icon: TrendingUp,
      description: "This month",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">
          Welcome, {session.user.firstName}!
        </h1>
        <p className="text-muted-foreground">
          Here&apos;s what&apos;s happening with your events.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <stat.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <p className="text-xs text-muted-foreground">{stat.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Events</CardTitle>
          </CardHeader>
          <CardContent>
            {recentEvents.length > 0 ? (
              <div className="space-y-4">
                {recentEvents.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-center justify-between"
                  >
                    <div>
                      <p className="font-medium">{event.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {new Date(event.startDate).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {event._count.registrations} registrations
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">
                No events yet. Create your first event to get started!
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Link
              href="/events/new"
              className="block rounded-lg border p-4 hover:bg-muted transition-colors"
            >
              <div className="flex items-center gap-3">
                <Calendar className="h-5 w-5 text-primary" />
                <div>
                  <p className="font-medium">Create New Event</p>
                  <p className="text-sm text-muted-foreground">
                    Start planning your next event
                  </p>
                </div>
              </div>
            </Link>
            <Link
              href="/settings"
              className="block rounded-lg border p-4 hover:bg-muted transition-colors"
            >
              <div className="flex items-center gap-3">
                <Users className="h-5 w-5 text-primary" />
                <div>
                  <p className="font-medium">Manage Team</p>
                  <p className="text-sm text-muted-foreground">
                    Add or remove team members
                  </p>
                </div>
              </div>
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
