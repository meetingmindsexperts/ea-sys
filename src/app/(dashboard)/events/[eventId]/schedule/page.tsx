"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
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
  Loader2,
  LayoutGrid,
} from "lucide-react";
import { formatDateLong, formatTime } from "@/lib/utils";
import { useSessions, useTracks, useSpeakers, queryKeys } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

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

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700",
  SCHEDULED: "bg-blue-100 text-blue-700",
  LIVE: "bg-green-100 text-green-700",
  COMPLETED: "bg-purple-100 text-purple-700",
  CANCELLED: "bg-red-100 text-red-700",
};

const SPEAKER_STATUS_COLORS: Record<string, string> = {
  CONFIRMED: "bg-green-100 text-green-700",
  INVITED: "bg-yellow-100 text-yellow-700",
  DECLINED: "bg-red-100 text-red-700",
};

const DEFAULT_SESSION_FORM = {
  name: "",
  description: "",
  trackId: "",
  startTime: "",
  endTime: "",
  location: "",
  capacity: "",
  status: "SCHEDULED",
  speakerIds: [] as string[],
};

const DEFAULT_TRACK_FORM = {
  name: "",
  description: "",
  color: "#3B82F6",
};

export default function SchedulePage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const isReviewer = session?.user?.role === "REVIEWER";

  const { data: sessions = [], isLoading: loading, isFetching } = useSessions(eventId);
  const { data: tracks = [] } = useTracks(eventId);
  const { data: speakers = [] } = useSpeakers(eventId);

  const [isSessionDialogOpen, setIsSessionDialogOpen] = useState(false);
  const [isTrackDialogOpen, setIsTrackDialogOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [sessionForm, setSessionForm] = useState(DEFAULT_SESSION_FORM);
  const [trackForm, setTrackForm] = useState(DEFAULT_TRACK_FORM);

  // ── Mutations ────────────────────────────────────────────────────────────
  const sessionMutation = useMutation({
    mutationFn: async ({ data, sessionId }: { data: Record<string, unknown>; sessionId?: string }) => {
      const res = await fetch(
        sessionId
          ? `/api/events/${eventId}/sessions/${sessionId}`
          : `/api/events/${eventId}/sessions`,
        {
          method: sessionId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      );
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

  const trackMutation = useMutation({
    mutationFn: async ({ data, trackId }: { data: Record<string, unknown>; trackId?: string }) => {
      const res = await fetch(
        trackId
          ? `/api/events/${eventId}/tracks/${trackId}`
          : `/api/events/${eventId}/tracks`,
        {
          method: trackId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      );
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

  const isSaving = sessionMutation.isPending || trackMutation.isPending;

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleSessionSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sessionMutation.mutate({
      data: {
        ...sessionForm,
        trackId: sessionForm.trackId || undefined,
        capacity: sessionForm.capacity ? parseInt(sessionForm.capacity) : undefined,
        startTime: new Date(sessionForm.startTime).toISOString(),
        endTime: new Date(sessionForm.endTime).toISOString(),
      },
      sessionId: editingSession?.id,
    });
  };

  const handleTrackSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    trackMutation.mutate({ data: trackForm, trackId: editingTrack?.id });
  };

  const handleDeleteTrack = (trackId: string) => {
    const assignedCount = (sessions as Session[]).filter((s) => s.track?.id === trackId).length;
    const msg = assignedCount > 0
      ? `This track has ${assignedCount} session(s) assigned. Deleting it will unassign them. Continue?`
      : "Are you sure you want to delete this track?";
    if (!confirm(msg)) return;
    deleteTrackMutation.mutate(trackId);
  };

  const handleDeleteSession = (sessionId: string) => {
    if (!confirm("Are you sure you want to delete this session?")) return;
    deleteSessionMutation.mutate(sessionId);
  };

  const openEditSession = (s: Session) => {
    setEditingSession(s);
    // Convert UTC ISO to local datetime-local format (YYYY-MM-DDTHH:MM)
    const toLocalInput = (iso: string) =>
      new Date(iso).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
    setSessionForm({
      name: s.name,
      description: s.description || "",
      trackId: s.track?.id || "",
      startTime: toLocalInput(s.startTime),
      endTime: toLocalInput(s.endTime),
      location: s.location || "",
      capacity: s.capacity?.toString() || "",
      status: s.status,
      speakerIds: s.speakers.map((sp) => sp.speaker.id),
    });
    setIsSessionDialogOpen(true);
  };

  const openEditTrack = (t: Track) => {
    setEditingTrack(t);
    setTrackForm({ name: t.name, description: "", color: t.color });
    setIsTrackDialogOpen(true);
  };

  const resetSessionForm = () => {
    setEditingSession(null);
    setSessionForm(DEFAULT_SESSION_FORM);
  };

  const resetTrackForm = () => {
    setEditingTrack(null);
    setTrackForm(DEFAULT_TRACK_FORM);
  };

  // ── Derived data ──────────────────────────────────────────────────────────
  const sessionsByDate = (sessions as Session[]).reduce<Record<string, Session[]>>((acc, s) => {
    const key = new Date(s.startTime).toDateString();
    (acc[key] ??= []).push(s);
    return acc;
  }, {});

  const sortedDates = Object.keys(sessionsByDate).sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime()
  );

  const stats = {
    total: (sessions as Session[]).length,
    scheduled: (sessions as Session[]).filter((s) => s.status === "SCHEDULED").length,
    tracks: (tracks as Track[]).length,
    days: sortedDates.length,
  };

  const showDelayedLoader = useDelayedLoading(loading, 1000);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Page header ──────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href={`/events/${eventId}`} className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Calendar className="h-7 w-7" />
              Schedule
              {isFetching && !loading && (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              )}
            </h1>
          </div>
          <p className="text-muted-foreground text-sm ml-6">
            Manage sessions, tracks, and the event programme
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button asChild variant="outline" size="sm">
            <Link href={`/events/${eventId}/schedule/calendar`}>
              <LayoutGrid className="mr-2 h-4 w-4" />
              Calendar
            </Link>
          </Button>

          {!isReviewer && (
            <>
              {/* Add Track */}
              <Dialog
                open={isTrackDialogOpen}
                onOpenChange={(open) => { setIsTrackDialogOpen(open); if (!open) resetTrackForm(); }}
              >
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Plus className="mr-1.5 h-4 w-4" />
                    Add Track
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{editingTrack ? "Edit Track" : "Create Track"}</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handleTrackSubmit} className="space-y-4 pt-1">
                    <div className="space-y-1.5">
                      <Label>Name</Label>
                      <Input
                        value={trackForm.name}
                        onChange={(e) => setTrackForm({ ...trackForm, name: e.target.value })}
                        placeholder="e.g. Main Stage, Workshop Room"
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Description (optional)</Label>
                      <Textarea
                        value={trackForm.description}
                        onChange={(e) => setTrackForm({ ...trackForm, description: e.target.value })}
                        rows={2}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Color</Label>
                      <div className="flex gap-2 items-center">
                        <input
                          type="color"
                          aria-label="Track color"
                          value={trackForm.color}
                          onChange={(e) => setTrackForm({ ...trackForm, color: e.target.value })}
                          className="h-9 w-14 rounded-md border cursor-pointer p-1"
                        />
                        <Input
                          value={trackForm.color}
                          onChange={(e) => setTrackForm({ ...trackForm, color: e.target.value })}
                          className="flex-1 font-mono text-sm"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 pt-2">
                      <Button type="button" variant="outline" onClick={() => setIsTrackDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button type="submit" disabled={isSaving}>
                        {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {editingTrack ? "Save Changes" : "Create Track"}
                      </Button>
                    </div>
                  </form>
                </DialogContent>
              </Dialog>

              {/* Add Session */}
              <Dialog
                open={isSessionDialogOpen}
                onOpenChange={(open) => { setIsSessionDialogOpen(open); if (!open) resetSessionForm(); }}
              >
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="mr-1.5 h-4 w-4" />
                    Add Session
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>{editingSession ? "Edit Session" : "Create Session"}</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handleSessionSubmit} className="space-y-4 pt-1">
                    {/* Name */}
                    <div className="space-y-1.5">
                      <Label>Session Name</Label>
                      <Input
                        value={sessionForm.name}
                        onChange={(e) => setSessionForm({ ...sessionForm, name: e.target.value })}
                        placeholder="e.g. Opening Keynote"
                        required
                      />
                    </div>

                    {/* Description */}
                    <div className="space-y-1.5">
                      <Label>Description (optional)</Label>
                      <Textarea
                        value={sessionForm.description}
                        onChange={(e) => setSessionForm({ ...sessionForm, description: e.target.value })}
                        rows={2}
                        placeholder="Brief description of the session…"
                      />
                    </div>

                    {/* Date & Times */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Start</Label>
                        <Input
                          type="datetime-local"
                          value={sessionForm.startTime}
                          onChange={(e) => setSessionForm({ ...sessionForm, startTime: e.target.value })}
                          required
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>End</Label>
                        <Input
                          type="datetime-local"
                          value={sessionForm.endTime}
                          onChange={(e) => setSessionForm({ ...sessionForm, endTime: e.target.value })}
                          required
                        />
                      </div>
                    </div>

                    {/* Track + Status */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Track</Label>
                        <Select
                          value={sessionForm.trackId}
                          onValueChange={(v) => setSessionForm({ ...sessionForm, trackId: v })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="None" />
                          </SelectTrigger>
                          <SelectContent>
                            {(tracks as Track[]).map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                <div className="flex items-center gap-2">
                                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: t.color }} />
                                  {t.name}
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Status</Label>
                        <Select
                          value={sessionForm.status}
                          onValueChange={(v) => setSessionForm({ ...sessionForm, status: v })}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
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

                    {/* Location + Capacity */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Location</Label>
                        <Input
                          value={sessionForm.location}
                          onChange={(e) => setSessionForm({ ...sessionForm, location: e.target.value })}
                          placeholder="Room or venue"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Capacity</Label>
                        <Input
                          type="number"
                          value={sessionForm.capacity}
                          onChange={(e) => setSessionForm({ ...sessionForm, capacity: e.target.value })}
                          placeholder="Max attendees"
                          min={1}
                        />
                      </div>
                    </div>

                    {/* Speakers */}
                    {(speakers as Speaker[]).length > 0 && (
                      <div className="space-y-1.5">
                        <Label>Speakers</Label>
                        <div className="border rounded-md divide-y max-h-36 overflow-y-auto">
                          {(speakers as Speaker[]).map((sp) => (
                            <label
                              key={sp.id}
                              className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50"
                            >
                              <Checkbox
                                checked={sessionForm.speakerIds.includes(sp.id)}
                                onCheckedChange={(checked: boolean) =>
                                  setSessionForm({
                                    ...sessionForm,
                                    speakerIds: checked
                                      ? [...sessionForm.speakerIds, sp.id]
                                      : sessionForm.speakerIds.filter((id) => id !== sp.id),
                                  })
                                }
                              />
                              <span className="flex-1 text-sm">
                                {sp.firstName} {sp.lastName}
                              </span>
                              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${SPEAKER_STATUS_COLORS[sp.status] ?? "bg-gray-100 text-gray-700"}`}>
                                {sp.status}
                              </span>
                            </label>
                          ))}
                        </div>
                        {sessionForm.speakerIds.length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {sessionForm.speakerIds.length} speaker{sessionForm.speakerIds.length !== 1 ? "s" : ""} selected
                          </p>
                        )}
                      </div>
                    )}

                    <div className="flex justify-end gap-2 pt-2">
                      <Button type="button" variant="outline" onClick={() => setIsSessionDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button type="submit" disabled={isSaving}>
                        {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {editingSession ? "Save Changes" : "Create Session"}
                      </Button>
                    </div>
                  </form>
                </DialogContent>
              </Dialog>
            </>
          )}
        </div>
      </div>

      {/* ── Stats row ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Sessions", value: stats.total, color: "" },
          { label: "Scheduled", value: stats.scheduled, color: "text-blue-600" },
          { label: "Tracks", value: stats.tracks, color: "" },
          { label: "Event Days", value: stats.days, color: "" },
        ].map(({ label, value, color }) => (
          <Card key={label} className="py-3">
            <CardContent className="px-4">
              <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
              <p className={`text-2xl font-bold ${color}`}>{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Tracks bar ──────────────────────────────────────────────── */}
      {(tracks as Track[]).length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Tracks</span>
          {(tracks as Track[]).map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm border"
              style={{ borderColor: t.color, color: t.color }}
            >
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color }} />
              <span className="font-medium">{t.name}</span>
              {!isReviewer && (
                <div className="flex gap-0.5 ml-1">
                  <button
                    type="button"
                    onClick={() => openEditTrack(t)}
                    className="p-0.5 rounded hover:bg-black/5 transition-colors"
                    title="Edit track"
                  >
                    <Edit className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteTrack(t.id)}
                    className="p-0.5 rounded hover:bg-red-50 text-red-500 transition-colors"
                    title="Delete track"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Sessions by date ─────────────────────────────────────────── */}
      {(sessions as Session[]).length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Calendar className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
            <p className="font-medium text-muted-foreground">No sessions yet</p>
            {!isReviewer && (
              <p className="text-sm text-muted-foreground mt-1">
                Click <strong>Add Session</strong> to build your schedule.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {sortedDates.map((dateKey) => {
            const daySessions = [...(sessionsByDate[dateKey] as Session[])].sort(
              (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
            );
            return (
              <div key={dateKey}>
                {/* Date heading */}
                <div className="flex items-center gap-3 mb-3">
                  <h2 className="text-base font-semibold">{formatDateLong(dateKey)}</h2>
                  <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                    {daySessions.length} session{daySessions.length !== 1 ? "s" : ""}
                  </span>
                  <div className="flex-1 h-px bg-border" />
                </div>

                <div className="space-y-2">
                  {daySessions.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-stretch rounded-lg border bg-card hover:shadow-sm transition-shadow group"
                    >
                      {/* Track color strip */}
                      <div
                        className="w-1 rounded-l-lg shrink-0"
                        style={{ backgroundColor: s.track?.color ?? "#e5e7eb" }}
                      />

                      {/* Time column */}
                      <div className="flex flex-col items-center justify-center px-4 py-3 min-w-[80px] border-r">
                        <span className="text-sm font-semibold tabular-nums">{formatTime(s.startTime)}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{formatTime(s.endTime)}</span>
                      </div>

                      {/* Main content */}
                      <div className="flex-1 px-4 py-3 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-sm truncate">{s.name}</span>
                              <Badge className={`${STATUS_COLORS[s.status]} text-xs px-1.5 py-0`} variant="outline">
                                {s.status.charAt(0) + s.status.slice(1).toLowerCase()}
                              </Badge>
                              {s.track && (
                                <Badge
                                  variant="outline"
                                  className="text-xs px-1.5 py-0"
                                  style={{ borderColor: s.track.color, color: s.track.color }}
                                >
                                  {s.track.name}
                                </Badge>
                              )}
                            </div>

                            {s.description && (
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                                {s.description}
                              </p>
                            )}

                            <div className="flex flex-wrap gap-3 mt-1.5 text-xs text-muted-foreground">
                              {s.location && (
                                <span className="flex items-center gap-1">
                                  <MapPin className="h-3 w-3" />
                                  {s.location}
                                </span>
                              )}
                              {s.capacity && (
                                <span className="flex items-center gap-1">
                                  <Users className="h-3 w-3" />
                                  {s.capacity}
                                </span>
                              )}
                              {s.speakers.length > 0 && (
                                <span className="flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  {s.speakers.map((sp) => `${sp.speaker.firstName} ${sp.speaker.lastName}`).join(", ")}
                                </span>
                              )}
                            </div>
                          </div>

                          {!isReviewer && (
                            <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => openEditSession(s)}
                              >
                                <Edit className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-50"
                                onClick={() => handleDeleteSession(s.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
