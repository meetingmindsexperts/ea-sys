import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, Mail, CheckCircle, Clock, XCircle } from "lucide-react";

const registrationStatusColors = {
  PENDING: "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
  WAITLISTED: "bg-blue-100 text-blue-800",
  CHECKED_IN: "bg-purple-100 text-purple-800",
};

const paymentStatusColors = {
  UNPAID: "bg-gray-100 text-gray-800",
  PENDING: "bg-yellow-100 text-yellow-800",
  PAID: "bg-green-100 text-green-800",
  REFUNDED: "bg-blue-100 text-blue-800",
  FAILED: "bg-red-100 text-red-800",
};

interface RegistrationsPageProps {
  params: Promise<{ eventId: string }>;
}

export default async function RegistrationsPage({
  params,
}: RegistrationsPageProps) {
  const { eventId } = await params;
  const session = await auth();

  if (!session?.user) {
    notFound();
  }

  const event = await db.event.findFirst({
    where: {
      id: eventId,
      organizationId: session.user.organizationId,
    },
  });

  if (!event) {
    notFound();
  }

  const registrations = await db.registration.findMany({
    where: {
      eventId,
    },
    include: {
      attendee: true,
      ticketType: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const stats = {
    total: registrations.length,
    confirmed: registrations.filter((r) => r.status === "CONFIRMED").length,
    pending: registrations.filter((r) => r.status === "PENDING").length,
    checkedIn: registrations.filter((r) => r.status === "CHECKED_IN").length,
    paid: registrations.filter((r) => r.paymentStatus === "PAID").length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Users className="h-8 w-8" />
            Registrations
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage attendee registrations for {event.name}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Registrations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Confirmed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.confirmed}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Pending
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Checked In
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-600">{stats.checkedIn}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Paid
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{stats.paid}</div>
          </CardContent>
        </Card>
      </div>

      {/* Registrations List */}
      <div>
        <h2 className="text-lg font-semibold mb-4">All Registrations</h2>
        {registrations.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-muted-foreground text-center py-8">
                No registrations yet. Registrations will appear here once attendees sign up.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {registrations.map((registration) => (
              <Card
                key={registration.id}
                className="hover:border-primary transition-colors"
              >
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-3">
                        <div>
                          <h3 className="text-lg font-semibold">
                            {registration.attendee.firstName}{" "}
                            {registration.attendee.lastName}
                          </h3>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                            <Mail className="h-4 w-4" />
                            {registration.attendee.email}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2 mb-3">
                        <Badge
                          className={registrationStatusColors[registration.status]}
                          variant="outline"
                        >
                          {registration.status}
                        </Badge>
                        <Badge
                          className={paymentStatusColors[registration.paymentStatus]}
                          variant="outline"
                        >
                          {registration.paymentStatus}
                        </Badge>
                        <Badge variant="outline">{registration.ticketType.name}</Badge>
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        {registration.attendee.company && (
                          <div>
                            <div className="text-muted-foreground">Company</div>
                            <div className="font-medium">
                              {registration.attendee.company}
                            </div>
                          </div>
                        )}
                        {registration.attendee.jobTitle && (
                          <div>
                            <div className="text-muted-foreground">Job Title</div>
                            <div className="font-medium">
                              {registration.attendee.jobTitle}
                            </div>
                          </div>
                        )}
                        <div>
                          <div className="text-muted-foreground">Registered</div>
                          <div className="font-medium">
                            {new Date(registration.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                        {registration.checkedInAt && (
                          <div>
                            <div className="text-muted-foreground">Checked In</div>
                            <div className="font-medium">
                              {new Date(registration.checkedInAt).toLocaleDateString()}
                            </div>
                          </div>
                        )}
                      </div>

                      {registration.notes && (
                        <div className="mt-3 p-2 bg-muted rounded text-sm">
                          <div className="text-muted-foreground font-medium mb-1">
                            Notes
                          </div>
                          <p>{registration.notes}</p>
                        </div>
                      )}
                    </div>

                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={`/events/${eventId}/registrations/${registration.id}`}
                      >
                        View Details
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
