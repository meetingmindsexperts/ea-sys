"use client";

import { useState } from "react";
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
  DialogTrigger,
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
  Calendar,
  Plus,
  Edit,
  Trash2,
  ArrowLeft,
  Clock,
  MapPin,
  Users,
  User,
  Loader2,
} from "lucide-react";
import { formatDateTime, formatDateLong, formatTime } from "@/lib/utils";
import { useSessions, useTracks, useSpeakers, queryKeys } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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

export default function SchedulePage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const queryClient = useQueryClient();

  // React Query hooks - data is cached and shared across navigations
  const { data: sessions = [], isLoading: loading, isFetching } = useSessions(eventId);
  const { data: tracks = [] } = useTracks(eventId);
  const { data: speakers = [] } = useSpeakers(eventId);

  const [isSessionDialogOpen, setIsSessionDialogOpen] = useState(false);
  const [isTrackDialogOpen, setIsTrackDialogOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
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
  const [trackFormData, setTrackFormData] = useState({
    name: "",
    description: "",
    color: "#3B82F6",
  });

  // Session mutations
  const sessionMutation = useMutation({
    mutationFn: async ({ data, sessionId }: { data: Record<string, unknown>; sessionId?: string }) => {
      const url = sessionId
        ? `/api/events/${eventId}/sessions/${sessionId}`
        : `/api/events/${eventId}/sessions`;
      const res = await fetch(url, {
        method: sessionId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save session");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions(eventId) });
      setIsSessionDialogOpen(false);
      resetSessionForm();
      toast.success(editingSession ? "Session updated" : "Session created");
    },
    onError: () => toast.error("Failed to save session"),
  });

  const deleteSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await fetch(`/api/events/${eventId}/sessions/${sessionId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete session");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions(eventId) });
      toast.success("Session deleted");
    },
    onError: () => toast.error("Failed to delete session"),
  });

  // Track mutations
  const trackMutation = useMutation({
    mutationFn: async ({ data, trackId }: { data: Record<string, unknown>; trackId?: string }) => {
      const url = trackId
        ? `/api/events/${eventId}/tracks/${trackId}`
        : `/api/events/${eventId}/tracks`;
      const res = await fetch(url, {
        method: trackId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save track");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tracks(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions(eventId) });
      setIsTrackDialogOpen(false);
      resetTrackForm();
      toast.success(editingTrack ? "Track updated" : "Track created");
    },
    onError: () => toast.error("Failed to save track"),
  });

  const deleteTrackMutation = useMutation({
    mutationFn: async (trackId: string) => {
      const res = await fetch(`/api/events/${eventId}/tracks/${trackId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete track");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tracks(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions(eventId) });
      toast.success("Track deleted");
    },
    onError: () => toast.error("Failed to delete track"),
  });

  const isSubmitting = sessionMutation.isPending || trackMutation.isPending;

  const handleSessionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    sessionMutation.mutate({
      data: {
        ...sessionFormData,
        trackId: sessionFormData.trackId || undefined,
        capacity: sessionFormData.capacity ? parseInt(sessionFormData.capacity) : undefined,
        startTime: new Date(sessionFormData.startTime).toISOString(),
        endTime: new Date(sessionFormData.endTime).toISOString(),
      },
      sessionId: editingSession?.id,
    });
  };

  const handleTrackSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    trackMutation.mutate({ data: trackFormData, trackId: editingTrack?.id });
  };

  const handleDeleteTrack = async (trackId: string) => {
    const trackSessions = sessions.filter((s: Session) => s.track?.id === trackId);
    if (trackSessions.length > 0) {
      if (
        !confirm(
          `This track has ${trackSessions.length} session(s) assigned. Deleting it will remove the track from those sessions. Continue?`
        )
      )
        return;
    } else {
      if (!confirm("Are you sure you want to delete this track?")) return;
    }
    deleteTrackMutation.mutate(trackId);
  };

  const openEditTrackDialog = (track: Track) => {
    setEditingTrack(track);
    setTrackFormData({
      name: track.name,
      description: "",
      color: track.color,
    });
    setIsTrackDialogOpen(true);
  };

  const resetTrackForm = () => {
    setEditingTrack(null);
    setTrackFormData({ name: "", description: "", color: "#3B82F6" });
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!confirm("Are you sure you want to delete this session?")) return;
    deleteSessionMutation.mutate(sessionId);
  };

  const openEditSessionDialog = (session: Session) => {
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
    setIsSessionDialogOpen(true);
  };

  const resetSessionForm = () => {
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

  // Group sessions by date
  const sessionsByDate = sessions.reduce((acc, session) => {
    const date = new Date(session.startTime).toDateString();
    if (!acc[date]) acc[date] = [];
    acc[date].push(session);
    return acc;
  }, {} as Record<string, Session[]>);

  const statusColors: Record<string, string> = {
    DRAFT: "bg-gray-100 text-gray-800",
    SCHEDULED: "bg-blue-100 text-blue-800",
    LIVE: "bg-green-100 text-green-800",
    COMPLETED: "bg-purple-100 text-purple-800",
    CANCELLED: "bg-red-100 text-red-800",
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link
              href={`/events/${eventId}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Calendar className="h-8 w-8" />
              Schedule
              {isFetching && !loading && (
                <span className="ml-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              )}
            </h1>
          </div>
          <p className="text-muted-foreground">
            Manage sessions, tracks, and the event schedule
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/events/${eventId}/schedule/calendar`}>
              <Calendar className="mr-2 h-4 w-4" />
              Calendar View
            </Link>
          </Button>
          <Dialog
            open={isTrackDialogOpen}
            onOpenChange={(open) => {
              setIsTrackDialogOpen(open);
              if (!open) resetTrackForm();
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline">
                <Plus className="mr-2 h-4 w-4" />
                Add Track
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {editingTrack ? "Edit Track" : "Create Track"}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleTrackSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="trackName">Name</Label>
                  <Input
                    id="trackName"
                    value={trackFormData.name}
                    onChange={(e) =>
                      setTrackFormData({ ...trackFormData, name: e.target.value })
                    }
                    placeholder="e.g., Main Stage, Workshop Room"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="trackDescription">Description</Label>
                  <Textarea
                    id="trackDescription"
                    value={trackFormData.description}
                    onChange={(e) =>
                      setTrackFormData({
                        ...trackFormData,
                        description: e.target.value,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="trackColor">Color</Label>
                  <div className="flex gap-2">
                    <Input
                      id="trackColor"
                      type="color"
                      value={trackFormData.color}
                      onChange={(e) =>
                        setTrackFormData({ ...trackFormData, color: e.target.value })
                      }
                      className="w-16 h-10 p-1"
                    />
                    <Input
                      value={trackFormData.color}
                      onChange={(e) =>
                        setTrackFormData({ ...trackFormData, color: e.target.value })
                      }
                      className="flex-1"
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsTrackDialogOpen(false)}
                    disabled={isSubmitting}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {editingTrack ? "Save Changes" : "Create Track"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog
            open={isSessionDialogOpen}
            onOpenChange={(open) => {
              setIsSessionDialogOpen(open);
              if (!open) resetSessionForm();
            }}
          >
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Session
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[600px]">
              <DialogHeader>
                <DialogTitle>
                  {editingSession ? "Edit Session" : "Create Session"}
                </DialogTitle>
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
                    onClick={() => setIsSessionDialogOpen(false)}
                    disabled={isSubmitting}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {editingSession ? "Save Changes" : "Create Session"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Tracks Overview */}
      {tracks.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Tracks</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {tracks.map((track) => (
                <div
                  key={track.id}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg border"
                  style={{ borderColor: track.color }}
                >
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: track.color }}
                  />
                  <span className="text-sm font-medium">{track.name}</span>
                  <div className="flex gap-1 ml-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => openEditTrackDialog(track)}
                    >
                      <Edit className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-red-600 hover:text-red-700"
                      onClick={() => handleDeleteTrack(track.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Sessions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{sessions.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tracks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{tracks.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Scheduled
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {sessions.filter((s) => s.status === "SCHEDULED").length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Event Days
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {Object.keys(sessionsByDate).length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sessions by Date */}
      <div className="space-y-6">
        {sessions.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-muted-foreground text-center py-8">
                No sessions yet. Click &quot;Add Session&quot; to get started.
              </p>
            </CardContent>
          </Card>
        ) : (
          Object.entries(sessionsByDate)
            .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
            .map(([date, dateSessions]) => (
              <div key={date}>
                <h2 className="text-lg font-semibold mb-4">
                  {formatDateLong(date)}
                </h2>
                <div className="space-y-3">
                  {(dateSessions as Session[])
                    .sort(
                      (a: Session, b: Session) =>
                        new Date(a.startTime).getTime() -
                        new Date(b.startTime).getTime()
                    )
                    .map((session: Session) => (
                      <Card
                        key={session.id}
                        className="hover:border-primary transition-colors"
                      >
                        <CardContent className="pt-4">
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-3 mb-2">
                                <h3 className="text-lg font-semibold">
                                  {session.name}
                                </h3>
                                <Badge
                                  className={statusColors[session.status]}
                                  variant="outline"
                                >
                                  {session.status}
                                </Badge>
                                {session.track && (
                                  <Badge
                                    variant="outline"
                                    style={{ borderColor: session.track.color }}
                                  >
                                    <div
                                      className="w-2 h-2 rounded-full mr-1"
                                      style={{
                                        backgroundColor: session.track.color,
                                      }}
                                    />
                                    {session.track.name}
                                  </Badge>
                                )}
                              </div>

                              {session.description && (
                                <p className="text-sm text-muted-foreground mb-3 line-clamp-2">
                                  {session.description}
                                </p>
                              )}

                              <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                                <div className="flex items-center gap-1">
                                  <Clock className="h-4 w-4" />
                                  {formatDateTime(session.startTime)} - {formatTime(session.endTime)}
                                </div>
                                {session.location && (
                                  <div className="flex items-center gap-1">
                                    <MapPin className="h-4 w-4" />
                                    {session.location}
                                  </div>
                                )}
                                {session.capacity && (
                                  <div className="flex items-center gap-1">
                                    <Users className="h-4 w-4" />
                                    Capacity: {session.capacity}
                                  </div>
                                )}
                              </div>

                              {session.speakers.length > 0 && (
                                <div className="mt-2 text-sm">
                                  <span className="text-muted-foreground">
                                    Speakers:{" "}
                                  </span>
                                  {session.speakers
                                    .map(
                                      (s: { speaker: Speaker }) =>
                                        `${s.speaker.firstName} ${s.speaker.lastName}`
                                    )
                                    .join(", ")}
                                </div>
                              )}
                            </div>

                            <div className="flex gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openEditSessionDialog(session)}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleDeleteSession(session.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                </div>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
