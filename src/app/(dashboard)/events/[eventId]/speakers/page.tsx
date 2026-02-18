import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildEventAccessWhere } from "@/lib/event-access";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Mic, Plus, Mail, MapPin } from "lucide-react";
import { ImportContactsButton } from "@/components/contacts/import-contacts-button";

const statusColors = {
  INVITED: "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-800",
  CANCELLED: "bg-gray-100 text-gray-800",
};

interface SpeakersPageProps {
  params: Promise<{ eventId: string }>;
}

export default async function SpeakersPage({ params }: SpeakersPageProps) {
  const [{ eventId }, session] = await Promise.all([params, auth()]);

  if (!session?.user) {
    notFound();
  }

  const [event, speakers] = await Promise.all([
    db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, name: true },
    }),
    db.speaker.findMany({
      where: { eventId },
      include: {
        _count: {
          select: {
            sessions: true,
            abstracts: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  if (!event) {
    notFound();
  }

  const isReviewer = session.user.role === "REVIEWER";

  const stats = {
    total: speakers.length,
    confirmed: speakers.filter((s) => s.status === "CONFIRMED").length,
    invited: speakers.filter((s) => s.status === "INVITED").length,
    declined: speakers.filter((s) => s.status === "DECLINED").length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Mic className="h-8 w-8" />
            Speakers
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage speakers for {event.name}
          </p>
        </div>
        {!isReviewer && (
          <div className="flex gap-2">
            <ImportContactsButton eventId={eventId} mode="speaker" />
            <Button asChild>
              <Link href={`/events/${eventId}/speakers/new`}>
                <Plus className="mr-2 h-4 w-4" />
                Add Speaker
              </Link>
            </Button>
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Speakers
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
              Invited
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{stats.invited}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Declined
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats.declined}</div>
          </CardContent>
        </Card>
      </div>

      {/* Speakers List */}
      <div>
        <h2 className="text-lg font-semibold mb-4">All Speakers</h2>
        {speakers.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-muted-foreground text-center py-8">
                No speakers yet. Click &quot;Add Speaker&quot; to get started.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {speakers.map((speaker) => (
              <Card key={speaker.id} className="hover:border-primary transition-colors">
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-lg font-semibold">
                          {speaker.firstName} {speaker.lastName}
                        </h3>
                        <Badge className={statusColors[speaker.status]} variant="outline">
                          {speaker.status}
                        </Badge>
                      </div>

                      <div className="space-y-1 text-sm text-muted-foreground mb-3">
                        {speaker.email && (
                          <div className="flex items-center gap-2">
                            <Mail className="h-4 w-4" />
                            {speaker.email}
                          </div>
                        )}
                        {speaker.organization && (
                          <div className="flex items-center gap-2">
                            <MapPin className="h-4 w-4" />
                            {speaker.organization}
                            {speaker.jobTitle && ` • ${speaker.jobTitle}`}
                          </div>
                        )}
                      </div>

                      {speaker.bio && (
                        <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                          {speaker.bio}
                        </p>
                      )}

                      <div className="flex gap-4 text-sm">
                        <div>
                          <span className="font-semibold">{speaker._count.sessions}</span>
                          <span className="text-muted-foreground"> Sessions</span>
                        </div>
                        <div>
                          <span className="font-semibold">{speaker._count.abstracts}</span>
                          <span className="text-muted-foreground"> Abstracts</span>
                        </div>
                      </div>
                    </div>

                    <Button asChild variant="outline" size="sm">
                      <Link href={`/events/${eventId}/speakers/${speaker.id}`}>
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
