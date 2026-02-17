import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar, Users, Ticket, TrendingUp, Plus, Settings, ArrowRight } from "lucide-react";

const eventStatusDot: Record<string, string> = {
  DRAFT:     "bg-gray-400",
  PUBLISHED: "bg-primary",
  LIVE:      "bg-green-500",
  COMPLETED: "bg-purple-400",
  CANCELLED: "bg-red-400",
};

const statIconStyle = [
  "bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300",
  "bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300",
  "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-300",
  "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300",
];

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  if (session.user.role === "REVIEWER" || session.user.role === "SUBMITTER") {
    redirect("/events");
  }

  const [eventCount, registrationCount, recentEvents] = await Promise.all([
    db.event.count({
      where: { organizationId: session.user.organizationId! },
    }),
    db.registration.count({
      where: { event: { organizationId: session.user.organizationId! } },
    }),
    db.event.findMany({
      where: { organizationId: session.user.organizationId! },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        name: true,
        status: true,
        startDate: true,
        _count: { select: { registrations: true } },
      },
    }),
  ]);

  const stats = [
    { title: "Total Events",        value: eventCount,        icon: Calendar,    description: "Active and completed" },
    { title: "Total Registrations", value: registrationCount, icon: Users,       description: "Across all events" },
    { title: "Tickets Sold",        value: registrationCount, icon: Ticket,      description: "This month" },
    { title: "Revenue",             value: "$0",              icon: TrendingUp,  description: "This month" },
  ];

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Welcome back, {session.user.firstName}
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Here&apos;s what&apos;s happening with your events.
        </p>
      </div>

      {/* ── Stats ──────────────────────────────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat, i) => (
          <Card key={stat.title}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-medium text-muted-foreground">
                  {stat.title}
                </span>
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${statIconStyle[i]}`}>
                  <stat.icon className="h-[18px] w-[18px]" />
                </div>
              </div>
              <div className="text-3xl font-bold tabular-nums">{stat.value}</div>
              <p className="text-xs text-muted-foreground mt-1">{stat.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Bottom Grid ────────────────────────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Recent Events */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Recent Events</CardTitle>
              <Button variant="ghost" size="sm" className="text-xs h-7 px-2 text-muted-foreground hover:text-foreground" asChild>
                <Link href="/events" className="flex items-center gap-1">
                  View all <ArrowRight className="h-3 w-3" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {recentEvents.length > 0 ? (
              <div className="space-y-1">
                {recentEvents.map((event) => (
                  <Link
                    key={event.id}
                    href={`/events/${event.id}`}
                    className="flex items-center justify-between rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors group"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${eventStatusDot[event.status] ?? "bg-gray-400"}`}
                      />
                      <div className="min-w-0">
                        <p className="font-medium text-sm leading-tight truncate group-hover:text-primary transition-colors">
                          {event.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(event.startDate).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0 ml-3">
                      {event._count.registrations} reg.
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center py-8 text-center">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
                  <Calendar className="h-5 w-5 text-primary" />
                </div>
                <p className="text-sm text-muted-foreground">
                  No events yet.{" "}
                  <Link href="/events/new" className="text-primary hover:underline">
                    Create your first.
                  </Link>
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            <Link
              href="/events/new"
              className="flex items-center gap-3 rounded-lg border p-3.5 hover:bg-muted/50 hover:border-primary/40 transition-all group"
            >
              <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Plus className="h-4.5 w-4.5 h-[18px] w-[18px]" />
              </div>
              <div className="min-w-0">
                <p className="font-medium text-sm group-hover:text-primary transition-colors">Create New Event</p>
                <p className="text-xs text-muted-foreground">Start planning your next event</p>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
            </Link>
            <Link
              href="/settings"
              className="flex items-center gap-3 rounded-lg border p-3.5 hover:bg-muted/50 hover:border-primary/40 transition-all group"
            >
              <div className="w-9 h-9 rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300 flex items-center justify-center shrink-0">
                <Settings className="h-[18px] w-[18px]" />
              </div>
              <div className="min-w-0">
                <p className="font-medium text-sm group-hover:text-primary transition-colors">Manage Team</p>
                <p className="text-xs text-muted-foreground">Add or remove team members</p>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
