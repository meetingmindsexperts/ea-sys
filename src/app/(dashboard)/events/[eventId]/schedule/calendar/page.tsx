"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  List,
  Clock,
  MapPin,
  Users,
} from "lucide-react";
import { formatTime } from "@/lib/utils";

interface Track {
  id: string;
  name: string;
  color: string;
}

interface Speaker {
  id: string;
  firstName: string;
  lastName: string;
}

interface Session {
  id: string;
  name: string;
  description: string | null;
  startTime: string;
  endTime: string;
  location: string | null;
  capacity: number | null;
  status: string;
  track: Track | null;
  speakers: Array<{ speaker: Speaker }>;
}

// Generate time slots from 6 AM to 10 PM
const TIME_SLOTS = Array.from({ length: 17 }, (_, i) => {
  const hour = i + 6;
  return {
    hour,
    label: `${hour > 12 ? hour - 12 : hour}:00 ${hour >= 12 ? "PM" : "AM"}`,
  };
});

const statusColors: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-800 border-gray-300",
  SCHEDULED: "bg-blue-100 text-blue-800 border-blue-300",
  LIVE: "bg-green-100 text-green-800 border-green-300",
  COMPLETED: "bg-purple-100 text-purple-800 border-purple-300",
  CANCELLED: "bg-red-100 text-red-800 border-red-300",
};

export default function ScheduleCalendarPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedTrack, setSelectedTrack] = useState<string>("all");

  useEffect(() => {
    Promise.all([fetchSessions(), fetchTracks()]);
  }, [eventId]);

  const fetchSessions = async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/sessions`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
        // Set initial selected date to first session date
        if (data.length > 0) {
          const firstDate = new Date(data[0].startTime).toISOString().split("T")[0];
          setSelectedDate(firstDate);
        }
      }
    } catch (error) {
      console.error("Error fetching sessions:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchTracks = async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/tracks`);
      if (res.ok) {
        const data = await res.json();
        setTracks(data);
      }
    } catch (error) {
      console.error("Error fetching tracks:", error);
    }
  };

  // Get unique dates from sessions
  const availableDates = useMemo(() => {
    const dates = new Set<string>();
    sessions.forEach((session) => {
      const date = new Date(session.startTime).toISOString().split("T")[0];
      dates.add(date);
    });
    return Array.from(dates).sort();
  }, [sessions]);

  // Filter sessions by selected date and track
  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      const sessionDate = new Date(session.startTime).toISOString().split("T")[0];
      const matchesDate = sessionDate === selectedDate;
      const matchesTrack = selectedTrack === "all" || session.track?.id === selectedTrack;
      return matchesDate && matchesTrack;
    });
  }, [sessions, selectedDate, selectedTrack]);

  // Calculate session position and height
  const getSessionStyle = (session: Session) => {
    const start = new Date(session.startTime);
    const end = new Date(session.endTime);

    const startHour = start.getUTCHours() + start.getUTCMinutes() / 60;
    const endHour = end.getUTCHours() + end.getUTCMinutes() / 60;

    const top = (startHour - 6) * 60; // 60px per hour, starting at 6 AM
    const height = Math.max((endHour - startHour) * 60, 30); // Minimum 30px height

    return {
      top: `${top}px`,
      height: `${height}px`,
    };
  };

  // Group sessions by track for multi-column layout
  const sessionsByTrack = useMemo(() => {
    const grouped: Record<string, Session[]> = {};
    filteredSessions.forEach((session) => {
      const trackId = session.track?.id || "no-track";
      if (!grouped[trackId]) {
        grouped[trackId] = [];
      }
      grouped[trackId].push(session);
    });
    return grouped;
  }, [filteredSessions]);

  const navigateDate = (direction: "prev" | "next") => {
    const currentIndex = availableDates.indexOf(selectedDate);
    if (direction === "prev" && currentIndex > 0) {
      setSelectedDate(availableDates[currentIndex - 1]);
    } else if (direction === "next" && currentIndex < availableDates.length - 1) {
      setSelectedDate(availableDates[currentIndex + 1]);
    }
  };

  const formatDateHeader = (dateStr: string) => {
    const date = new Date(dateStr + "T00:00:00Z");
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${days[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <h1 className="text-3xl font-bold flex items-center gap-2">
                <Calendar className="h-8 w-8" />
                Schedule Calendar
              </h1>
            </div>
            <p className="text-muted-foreground">
              View sessions in calendar format
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href={`/events/${eventId}/schedule`}>
              <List className="mr-2 h-4 w-4" />
              List View
            </Link>
          </Button>
        </div>

        {/* Controls */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between gap-4">
              {/* Date Navigation */}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => navigateDate("prev")}
                  disabled={availableDates.indexOf(selectedDate) <= 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <div className="min-w-[250px] text-center">
                  <Select value={selectedDate} onValueChange={setSelectedDate}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a date" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableDates.map((date) => (
                        <SelectItem key={date} value={date}>
                          {formatDateHeader(date)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => navigateDate("next")}
                  disabled={availableDates.indexOf(selectedDate) >= availableDates.length - 1}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              {/* Track Filter */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Filter by track:</span>
                <Select value={selectedTrack} onValueChange={setSelectedTrack}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="All Tracks" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Tracks</SelectItem>
                    {tracks.map((track) => (
                      <SelectItem key={track.id} value={track.id}>
                        <div className="flex items-center gap-2">
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: track.color }}
                          />
                          {track.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Calendar Grid */}
        {sessions.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-muted-foreground text-center py-8">
                No sessions yet. Create sessions in the list view first.
              </p>
            </CardContent>
          </Card>
        ) : availableDates.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-muted-foreground text-center py-8">
                No sessions scheduled.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>{selectedDate && formatDateHeader(selectedDate)}</CardTitle>
              <p className="text-sm text-muted-foreground">
                {filteredSessions.length} session{filteredSessions.length !== 1 ? "s" : ""}
              </p>
            </CardHeader>
            <CardContent>
              <div className="flex">
                {/* Time Column */}
                <div className="w-20 flex-shrink-0 border-r">
                  {TIME_SLOTS.map((slot) => (
                    <div
                      key={slot.hour}
                      className="h-[60px] text-xs text-muted-foreground pr-2 text-right border-b"
                    >
                      {slot.label}
                    </div>
                  ))}
                </div>

                {/* Sessions Grid */}
                <div className="flex-1 relative min-h-[1020px]">
                  {/* Hour lines */}
                  {TIME_SLOTS.map((slot, index) => (
                    <div
                      key={slot.hour}
                      className="absolute w-full border-b border-dashed border-muted"
                      style={{ top: `${index * 60}px`, height: "60px" }}
                    />
                  ))}

                  {/* Sessions */}
                  {selectedTrack === "all" ? (
                    // Multi-track view - columns for each track
                    <div className="absolute inset-0 flex">
                      {Object.entries(sessionsByTrack).map(([trackId, trackSessions], index) => {
                        const track = tracks.find((t) => t.id === trackId);
                        const columnWidth = 100 / Object.keys(sessionsByTrack).length;

                        return (
                          <div
                            key={trackId}
                            className="relative border-r last:border-r-0"
                            style={{ width: `${columnWidth}%` }}
                          >
                            {/* Track header */}
                            <div
                              className="sticky top-0 z-10 p-2 text-xs font-medium text-center border-b"
                              style={{ backgroundColor: track?.color ? `${track.color}20` : "#f3f4f6" }}
                            >
                              <div className="flex items-center justify-center gap-1">
                                {track && (
                                  <div
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: track.color }}
                                  />
                                )}
                                {track?.name || "No Track"}
                              </div>
                            </div>

                            {/* Sessions in this track */}
                            {trackSessions.map((session) => (
                              <SessionCard
                                key={session.id}
                                session={session}
                                style={getSessionStyle(session)}
                                eventId={eventId}
                              />
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    // Single track view - full width
                    <div className="absolute inset-0 pl-2 pr-2">
                      {filteredSessions.map((session) => (
                        <SessionCard
                          key={session.id}
                          session={session}
                          style={getSessionStyle(session)}
                          eventId={eventId}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Legend */}
        {tracks.length > 0 && (
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap gap-4">
                <span className="text-sm font-medium">Tracks:</span>
                {tracks.map((track) => (
                  <div key={track.id} className="flex items-center gap-2">
                    <div
                      className="w-4 h-4 rounded"
                      style={{ backgroundColor: track.color }}
                    />
                    <span className="text-sm">{track.name}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </TooltipProvider>
  );
}

// Session Card Component
function SessionCard({
  session,
  style,
  eventId,
}: {
  session: Session;
  style: { top: string; height: string };
  eventId: string;
}) {
  const trackColor = session.track?.color || "#6B7280";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={`/events/${eventId}/schedule`}
          className="absolute left-1 right-1 rounded-md p-2 overflow-hidden cursor-pointer transition-all hover:shadow-lg hover:z-20"
          style={{
            ...style,
            backgroundColor: `${trackColor}15`,
            borderLeft: `3px solid ${trackColor}`,
          }}
        >
          <div className="text-xs font-medium truncate">{session.name}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {formatTime(session.startTime)} - {formatTime(session.endTime)}
          </div>
          {session.location && parseInt(style.height) >= 50 && (
            <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {session.location}
            </div>
          )}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        <div className="space-y-2">
          <div className="font-medium">{session.name}</div>
          <div className="text-xs space-y-1">
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatTime(session.startTime)} - {formatTime(session.endTime)}
            </div>
            {session.location && (
              <div className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {session.location}
              </div>
            )}
            {session.capacity && (
              <div className="flex items-center gap-1">
                <Users className="h-3 w-3" />
                Capacity: {session.capacity}
              </div>
            )}
            {session.track && (
              <div className="flex items-center gap-1">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: session.track.color }}
                />
                {session.track.name}
              </div>
            )}
            {session.speakers.length > 0 && (
              <div>
                Speakers: {session.speakers.map((s) => `${s.speaker.firstName} ${s.speaker.lastName}`).join(", ")}
              </div>
            )}
          </div>
          <Badge className={statusColors[session.status]} variant="outline">
            {session.status}
          </Badge>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
