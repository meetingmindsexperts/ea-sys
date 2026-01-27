"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
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
  User,
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
  status: string;
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
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedTrack, setSelectedTrack] = useState<string>("all");

  // Edit dialog state
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [sessionFormData, setSessionFormData] = useState({
    name: "",
    description: "",
    trackId: "",
    startTime: "",
    endTime: "",
    location: "",
    capacity: "",
    status: "SCHEDULED",
    speakerIds: [] as string[],
  });

  useEffect(() => {
    Promise.all([fetchSessions(), fetchTracks(), fetchSpeakers()]);
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

  const fetchSpeakers = async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/speakers`);
      if (res.ok) {
        const data = await res.json();
        setSpeakers(data);
      }
    } catch (error) {
      console.error("Error fetching speakers:", error);
    }
  };

  const openEditDialog = (session: Session) => {
    setEditingSession(session);
    setSessionFormData({
      name: session.name,
      description: session.description || "",
      trackId: session.track?.id || "",
      startTime: new Date(session.startTime).toISOString().slice(0, 16),
      endTime: new Date(session.endTime).toISOString().slice(0, 16),
      location: session.location || "",
      capacity: session.capacity?.toString() || "",
      status: session.status,
      speakerIds: session.speakers.map((s) => s.speaker.id),
    });
    setIsEditDialogOpen(true);
  };

  const resetForm = () => {
    setEditingSession(null);
    setSessionFormData({
      name: "",
      description: "",
      trackId: "",
      startTime: "",
      endTime: "",
      location: "",
      capacity: "",
      status: "SCHEDULED",
      speakerIds: [],
    });
  };

  const handleSessionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSession) return;

    try {
      const res = await fetch(`/api/events/${eventId}/sessions/${editingSession.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...sessionFormData,
          trackId: sessionFormData.trackId || undefined,
          capacity: sessionFormData.capacity ? parseInt(sessionFormData.capacity) : undefined,
          startTime: new Date(sessionFormData.startTime).toISOString(),
          endTime: new Date(sessionFormData.endTime).toISOString(),
        }),
      });

      if (res.ok) {
        fetchSessions();
        setIsEditDialogOpen(false);
        resetForm();
      }
    } catch (error) {
      console.error("Error saving session:", error);
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
              View sessions in calendar format. Click a session to edit.
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
                      {Object.entries(sessionsByTrack).map(([trackId, trackSessions]) => {
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
                                onClick={() => openEditDialog(session)}
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
                          onClick={() => openEditDialog(session)}
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

        {/* Edit Session Dialog */}
        <Dialog
          open={isEditDialogOpen}
          onOpenChange={(open) => {
            setIsEditDialogOpen(open);
            if (!open) resetForm();
          }}
        >
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>Edit Session</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSessionSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="sessionName">Name</Label>
                <Input
                  id="sessionName"
                  value={sessionFormData.name}
                  onChange={(e) =>
                    setSessionFormData({
                      ...sessionFormData,
                      name: e.target.value,
                    })
                  }
                  placeholder="Session title"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sessionDescription">Description</Label>
                <Textarea
                  id="sessionDescription"
                  value={sessionFormData.description}
                  onChange={(e) =>
                    setSessionFormData({
                      ...sessionFormData,
                      description: e.target.value,
                    })
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="startTime">Start Time</Label>
                  <Input
                    id="startTime"
                    type="datetime-local"
                    value={sessionFormData.startTime}
                    onChange={(e) =>
                      setSessionFormData({
                        ...sessionFormData,
                        startTime: e.target.value,
                      })
                    }
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="endTime">End Time</Label>
                  <Input
                    id="endTime"
                    type="datetime-local"
                    value={sessionFormData.endTime}
                    onChange={(e) =>
                      setSessionFormData({
                        ...sessionFormData,
                        endTime: e.target.value,
                      })
                    }
                    required
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="track">Track</Label>
                  <Select
                    value={sessionFormData.trackId}
                    onValueChange={(value) =>
                      setSessionFormData({ ...sessionFormData, trackId: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select track" />
                    </SelectTrigger>
                    <SelectContent>
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
                <div className="space-y-2">
                  <Label htmlFor="status">Status</Label>
                  <Select
                    value={sessionFormData.status}
                    onValueChange={(value) =>
                      setSessionFormData({ ...sessionFormData, status: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DRAFT">Draft</SelectItem>
                      <SelectItem value="SCHEDULED">Scheduled</SelectItem>
                      <SelectItem value="LIVE">Live</SelectItem>
                      <SelectItem value="COMPLETED">Completed</SelectItem>
                      <SelectItem value="CANCELLED">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="location">Location</Label>
                  <Input
                    id="location"
                    value={sessionFormData.location}
                    onChange={(e) =>
                      setSessionFormData({
                        ...sessionFormData,
                        location: e.target.value,
                      })
                    }
                    placeholder="Room or venue"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="capacity">Capacity</Label>
                  <Input
                    id="capacity"
                    type="number"
                    value={sessionFormData.capacity}
                    onChange={(e) =>
                      setSessionFormData({
                        ...sessionFormData,
                        capacity: e.target.value,
                      })
                    }
                    placeholder="Max attendees"
                  />
                </div>
              </div>
              {speakers.length > 0 && (
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <User className="h-4 w-4" />
                    Speakers
                  </Label>
                  <div className="border rounded-md p-3 max-h-40 overflow-y-auto space-y-2">
                    {speakers.map((speaker) => (
                      <div key={speaker.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`speaker-${speaker.id}`}
                          checked={sessionFormData.speakerIds.includes(speaker.id)}
                          onCheckedChange={(checked: boolean) => {
                            if (checked) {
                              setSessionFormData({
                                ...sessionFormData,
                                speakerIds: [...sessionFormData.speakerIds, speaker.id],
                              });
                            } else {
                              setSessionFormData({
                                ...sessionFormData,
                                speakerIds: sessionFormData.speakerIds.filter(
                                  (id) => id !== speaker.id
                                ),
                              });
                            }
                          }}
                        />
                        <label
                          htmlFor={`speaker-${speaker.id}`}
                          className="text-sm cursor-pointer flex-1 flex items-center gap-2"
                        >
                          {speaker.firstName} {speaker.lastName}
                          <span className={`text-xs px-1.5 py-0.5 rounded ${
                            speaker.status === "CONFIRMED" ? "bg-green-100 text-green-700" :
                            speaker.status === "INVITED" ? "bg-yellow-100 text-yellow-700" :
                            speaker.status === "DECLINED" ? "bg-red-100 text-red-700" :
                            "bg-gray-100 text-gray-700"
                          }`}>
                            {speaker.status}
                          </span>
                        </label>
                      </div>
                    ))}
                  </div>
                  {sessionFormData.speakerIds.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {sessionFormData.speakerIds.length} speaker{sessionFormData.speakerIds.length !== 1 ? "s" : ""} selected
                    </p>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsEditDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit">Save Changes</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

// Session Card Component
function SessionCard({
  session,
  style,
  onClick,
}: {
  session: Session;
  style: { top: string; height: string };
  onClick: () => void;
}) {
  const trackColor = session.track?.color || "#6B7280";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className="absolute left-1 right-1 rounded-md p-2 overflow-hidden cursor-pointer transition-all hover:shadow-lg hover:z-20 text-left"
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
        </button>
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
          <p className="text-xs text-muted-foreground italic">Click to edit</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
