"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Mic, Plus, Mail, MapPin, RefreshCw } from "lucide-react";
import { formatPersonName } from "@/lib/utils";
import { ImportContactsButton } from "@/components/contacts/import-contacts-button";
import { useSpeakers, useEvent } from "@/hooks/use-api";
import { useSession } from "next-auth/react";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

const statusColors: Record<string, string> = {
  INVITED: "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-800",
  CANCELLED: "bg-gray-100 text-gray-800",
};

interface Speaker {
  id: string;
  title: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  organization: string | null;
  jobTitle: string | null;
  bio: string | null;
  tags: string[];
  status: string;
  _count: { sessions: number; abstracts: number };
}

export default function SpeakersPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const { data: userSession } = useSession();
  const isReviewer = userSession?.user?.role === "REVIEWER";

  const { data: event } = useEvent(eventId);
  const { data: speakersData = [], isLoading: loading, isFetching, refetch } = useSpeakers(eventId);
  const speakers = speakersData as Speaker[];

  const showDelayedLoader = useDelayedLoading(loading, 1000);

  const stats = {
    total: speakers.length,
    confirmed: speakers.filter((s) => s.status === "CONFIRMED").length,
    invited: speakers.filter((s) => s.status === "INVITED").length,
    declined: speakers.filter((s) => s.status === "DECLINED").length,
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Mic className="h-8 w-8" />
            Speakers
            {isFetching && !loading && (
              <span className="ml-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            )}
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage speakers{event?.name ? ` for ${event.name}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            title="Refresh data"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          {!isReviewer && (
            <>
              <ImportContactsButton eventId={eventId} mode="speaker" />
              <Button asChild>
                <Link href={`/events/${eventId}/speakers/new`}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Speaker
                </Link>
              </Button>
            </>
          )}
        </div>
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
                          {formatPersonName(speaker.title, speaker.firstName, speaker.lastName)}
                        </h3>
                        <Badge className={statusColors[speaker.status] ?? "bg-gray-100 text-gray-800"} variant="outline">
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

                      {speaker.tags && speaker.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-3">
                          {speaker.tags.map((tag, index) => (
                            <Badge key={index} variant="secondary" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                        </div>
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
