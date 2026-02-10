import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Calendar,
  MapPin,
  Users,
  Ticket,
  Mic,
  Building2,
  Settings,
  Edit,
} from "lucide-react";
import { formatDateRange } from "@/lib/utils";

const statusColors = {
  DRAFT: "bg-gray-100 text-gray-800",
  PUBLISHED: "bg-blue-100 text-blue-800",
  LIVE: "bg-green-100 text-green-800",
  COMPLETED: "bg-purple-100 text-purple-800",
  CANCELLED: "bg-red-100 text-red-800",
};

interface EventPageProps {
  params: Promise<{ eventId: string }>;
}

export default async function EventPage({ params }: EventPageProps) {
  const [{ eventId }, session] = await Promise.all([params, auth()]);

  if (!session?.user) {
    notFound();
  }

  const event = await db.event.findFirst({
    where: {
      id: eventId,
      organizationId: session.user.organizationId,
    },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      startDate: true,
      endDate: true,
      venue: true,
      city: true,
      country: true,
      _count: {
        select: {
          registrations: true,
          speakers: true,
          eventSessions: true,
          hotels: true,
        },
      },
    },
  });

  if (!event) {
    notFound();
  }

  const stats = [
    {
      title: "Registrations",
      value: event._count.registrations,
      icon: Users,
      href: `/events/${eventId}/registrations`,
    },
    {
      title: "Speakers",
      value: event._count.speakers,
      icon: Mic,
      href: `/events/${eventId}/speakers`,
    },
    {
      title: "Sessions",
      value: event._count.eventSessions,
      icon: Calendar,
      href: `/events/${eventId}/schedule`,
    },
    {
      title: "Hotels",
      value: event._count.hotels,
      icon: Building2,
      href: `/events/${eventId}/accommodation`,
    },
  ];

  const quickActions = [
    {
      title: "Manage Registration Types",
      description: "Create and edit ticket types",
      icon: Ticket,
      href: `/events/${eventId}/tickets`,
    },
    {
      title: "Manage Speakers",
      description: "Add speakers and manage abstracts",
      icon: Mic,
      href: `/events/${eventId}/speakers`,
    },
    {
      title: "Build Schedule",
      description: "Create sessions and tracks",
      icon: Calendar,
      href: `/events/${eventId}/schedule`,
    },
    {
      title: "Event Settings",
      description: "Configure event details",
      icon: Settings,
      href: `/events/${eventId}/settings`,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold">{event.name}</h1>
            <Badge className={statusColors[event.status]} variant="outline">
              {event.status}
            </Badge>
          </div>
          {event.description && (
            <p className="text-muted-foreground max-w-2xl">{event.description}</p>
          )}
        </div>
        <Button asChild>
          <Link href={`/events/${eventId}/settings`}>
            <Edit className="mr-2 h-4 w-4" />
            Edit Event
          </Link>
        </Button>
      </div>

      {/* Event Details */}
      <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4" />
          {formatDateRange(event.startDate, event.endDate)}
        </div>
        {event.venue && (
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4" />
            {event.venue}
            {event.city && `, ${event.city}`}
            {event.country && `, ${event.country}`}
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Link key={stat.title} href={stat.href}>
            <Card className="hover:border-primary transition-colors cursor-pointer">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  {stat.title}
                </CardTitle>
                <stat.icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stat.value}</div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Quick Actions</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {quickActions.map((action) => (
            <Link key={action.title} href={action.href}>
              <Card className="hover:border-primary transition-colors cursor-pointer h-full">
                <CardContent className="pt-6">
                  <action.icon className="h-8 w-8 text-primary mb-3" />
                  <h3 className="font-medium">{action.title}</h3>
                  <p className="text-sm text-muted-foreground">
                    {action.description}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      {/* Recent Activity Placeholder */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            No recent activity yet. Start by creating tickets or adding speakers.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
