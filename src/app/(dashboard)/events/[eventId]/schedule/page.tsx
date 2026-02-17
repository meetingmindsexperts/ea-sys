"use client";

import { useState, useMemo } from "react";
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
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  List,
  Plus,
  Edit,
  Trash2,
  ArrowLeft,
  Clock,
  MapPin,
  Users,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { formatTime } from "@/lib/utils";
import { useSessions, useTracks, useSpeakers, useEvent, queryKeys } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Constants ────────────────────────────────────────────────────────────────

const HOUR_HEIGHT = 64; // px per hour
const START_HOUR = 6;   // 6 AM
const END_HOUR = 23;    // exclusive — last label is 10 PM

const TIME_SLOTS = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => {
  const h = i + START_HOUR;
  const suffix = h >= 12 ? "PM" : "AM";
  const display = h > 12 ? h - 12 : h;
  return { hour: h, label: `${display}:00 ${suffix}` };
});

const GRID_HEIGHT = (END_HOUR - START_HOUR) * HOUR_HEIGHT;

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

const DEFAULT_TRACK_FORM = { name: "", description: "", color: "#3B82F6" };

// ── Helpers ──────────────────────────────────────────────────────────────────

function toLocalDateStr(d: Date) {
  return d.toLocaleDateString("sv-SE"); // YYYY-MM-DD
}

function formatDateDisplay(dateStr: string) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function padZ(n: number) {
  return String(n).padStart(2, "0");
}

function getSessionStyle(s: Session) {
  const start = new Date(s.startTime);
  const end = new Date(s.endTime);
  const startH = start.getHours() + start.getMinutes() / 60;
  const endH = end.getHours() + end.getMinutes() / 60;
  const top = (startH - START_HOUR) * HOUR_HEIGHT;
  const height = Math.max((endH - startH) * HOUR_HEIGHT, 28);
  return { top: `${top}px`, height: `${height}px` };
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function SchedulePage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const queryClient = useQueryClient();
  const { data: authSession } = useSession();
  const isReviewer =
    authSession?.user?.role === "REVIEWER" ||
    authSession?.user?.role === "SUBMITTER";

  const { data: event } = useEvent(eventId);
  const { data: sessions = [], isLoading: loading, isFetching } = useSessions(eventId);
  const { data: tracks = [] } = useTracks(eventId);
  const { data: speakers = [] } = useSpeakers(eventId);

  // Event date boundaries (YYYY-MM-DD)
  const minDate = event?.startDate ? toLocalDateStr(new Date(event.startDate)) : "";
  const maxDate = event?.endDate ? toLocalDateStr(new Date(event.endDate)) : "";

  // null = not yet chosen by user; resolves to event start date once loaded
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const resolvedDate = selectedDate ?? (minDate || toLocalDateStr(new Date()));
  const [selectedTrack, setSelectedTrack] = useState("all");
  const [isSessionDialogOpen, setIsSessionDialogOpen] = useState(false);
  const [isTrackDialogOpen, setIsTrackDialogOpen] = useState(false);
  const [isSessionListOpen, setIsSessionListOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [sessionForm, setSessionForm] = useState(DEFAULT_SESSION_FORM);
  const [trackForm, setTrackForm] = useState(DEFAULT_TRACK_FORM);

  // ── Mutations ─────────────────────────────────────────────────────────────

  const sessionMutation = useMutation({
    mutationFn: async ({
      data,
      sessionId,
    }: {
      data: Record<string, unknown>;
      sessionId?: string;
    }) => {
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
      const res = await fetch(`/api/events/${eventId}/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete session");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions(eventId) });
      toast.success("Session deleted");
    },
    onError: () => toast.error("Failed to delete session"),
  });

  const trackMutation = useMutation({
    mutationFn: async ({
      data,
      trackId,
    }: {
      data: Record<string, unknown>;
      trackId?: string;
    }) => {
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
      const res = await fetch(`/api/events/${eventId}/tracks/${trackId}`, {
        method: "DELETE",
      });
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

  // ── Handlers ──────────────────────────────────────────────────────────────

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
    const count = (sessions as Session[]).filter((s) => s.track?.id === trackId).length;
    const msg =
      count > 0
        ? `This track has ${count} session(s). Deleting it will unassign them. Continue?`
        : "Delete this track?";
    if (!confirm(msg)) return;
    deleteTrackMutation.mutate(trackId);
  };

  const handleDeleteSession = (sessionId: string) => {
    if (!confirm("Delete this session?")) return;
    deleteSessionMutation.mutate(sessionId);
    setIsSessionDialogOpen(false);
  };

  const openEditSession = (s: Session) => {
    setEditingSession(s);
    const toLocal = (iso: string) =>
      new Date(iso).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
    setSessionForm({
      name: s.name,
      description: s.description || "",
      trackId: s.track?.id || "",
      startTime: toLocal(s.startTime),
      endTime: toLocal(s.endTime),
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

  const openAddSession = () => {
    resetSessionForm();
    setIsSessionDialogOpen(true);
  };

  const openAddTrack = () => {
    resetTrackForm();
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

  // Click on calendar grid → pre-fill startTime/endTime from Y position
  const handleSlotClick = (e: React.MouseEvent<HTMLDivElement>, trackId?: string) => {
    if (isReviewer) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    // Snap to nearest 15-minute mark
    const totalMins = Math.floor((y / HOUR_HEIGHT) * 60);
    const snapped = Math.round(totalMins / 15) * 15;
    const h = START_HOUR + Math.floor(snapped / 60);
    const m = snapped % 60;
    const startH = Math.min(h, END_HOUR - 2);
    const endH = Math.min(startH + 1, END_HOUR - 1);
    const startDT = `${resolvedDate}T${padZ(startH)}:${padZ(m)}`;
    const endDT = `${resolvedDate}T${padZ(endH)}:${padZ(m)}`;
    setEditingSession(null);
    setSessionForm({
      ...DEFAULT_SESSION_FORM,
      startTime: startDT,
      endTime: endDT,
      trackId: trackId && trackId !== "no-track" ? trackId : "",
    });
    setIsSessionDialogOpen(true);
  };

  const navigateDate = (dir: 1 | -1) => {
    const d = new Date(resolvedDate + "T00:00:00");
    d.setDate(d.getDate() + dir);
    const next = toLocalDateStr(d);
    if (minDate && next < minDate) return;
    if (maxDate && next > maxDate) return;
    setSelectedDate(next);
  };

  // ── Derived data ──────────────────────────────────────────────────────────

  const filteredSessions = useMemo(() => {
    return (sessions as Session[]).filter((s) => {
      const sd = new Date(s.startTime).toLocaleDateString("sv-SE");
      const matchDate = sd === resolvedDate;
      const matchTrack = selectedTrack === "all" || s.track?.id === selectedTrack;
      return matchDate && matchTrack;
    });
  }, [sessions, resolvedDate, selectedTrack]);

  const sessionsByTrack = useMemo(() => {
    const grouped: Record<string, Session[]> = {};
    filteredSessions.forEach((s) => {
      const tid = s.track?.id || "no-track";
      (grouped[tid] ??= []).push(s);
    });
    return grouped;
  }, [filteredSessions]);

  // Track group IDs visible on this day (for multi-column layout)
  const visibleTrackIds = useMemo(
    () => (selectedTrack === "all" ? Object.keys(sessionsByTrack) : []),
    [selectedTrack, sessionsByTrack]
  );

  const showMultiColumn = selectedTrack === "all" && visibleTrackIds.length > 1;

  const allEventDates = useMemo(() => {
    const s = new Set<string>();
    (sessions as Session[]).forEach((sess) =>
      s.add(new Date(sess.startTime).toLocaleDateString("sv-SE"))
    );
    return s.size;
  }, [sessions]);

  const stats = {
    total: (sessions as Session[]).length,
    scheduled: (sessions as Session[]).filter((s) => s.status === "SCHEDULED").length,
    tracks: (tracks as Track[]).length,
    days: allEventDates,
  };

  // Sessions grouped by date for the list panel
  const sessionsByDate = useMemo(() => {
    const map: Record<string, Session[]> = {};
    (sessions as Session[]).forEach((s) => {
      const day = new Date(s.startTime).toLocaleDateString("sv-SE");
      (map[day] ??= []).push(s);
    });
    // Sort each day's sessions by start time
    Object.values(map).forEach((arr) =>
      arr.sort(
        (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
      )
    );
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [sessions]);

  const showDelayedLoader = useDelayedLoading(loading, 1000);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* ── Page header ──────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link
                href={`/events/${eventId}`}
                className="text-muted-foreground hover:text-foreground"
              >
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
              {isReviewer
                ? "View the event schedule"
                : "Click any time slot to add a session · Click a session to edit"}
            </p>
          </div>

          {!isReviewer && (
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={openAddTrack}>
                <Plus className="mr-1.5 h-4 w-4" />
                Add Track
              </Button>
              <Button size="sm" onClick={openAddSession}>
                <Plus className="mr-1.5 h-4 w-4" />
                Add Session
              </Button>
            </div>
          )}
        </div>

        {/* ── Stats ────────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card
            className="py-3 cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
            onClick={() => setIsSessionListOpen(true)}
          >
            <CardContent className="px-4">
              <p className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
                Sessions
                <List className="h-3 w-3" />
              </p>
              <p className="text-2xl font-bold">{stats.total}</p>
            </CardContent>
          </Card>
          {[
            { label: "Scheduled", value: stats.scheduled },
            { label: "Tracks", value: stats.tracks },
            { label: "Event Days", value: stats.days },
          ].map(({ label, value }) => (
            <Card key={label} className="py-3">
              <CardContent className="px-4">
                <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
                <p className="text-2xl font-bold">{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* ── Tracks bar ───────────────────────────────────────────────────── */}
        {(tracks as Track[]).length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Tracks
            </span>
            {(tracks as Track[]).map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm border"
                style={{ borderColor: t.color, color: t.color }}
              >
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: t.color }}
                />
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

        {/* ── Calendar controls ────────────────────────────────────────────── */}
        <Card>
          <CardContent className="py-3 px-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              {/* Date navigation */}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => navigateDate(-1)}
                  disabled={!!minDate && resolvedDate <= minDate}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <input
                  type="date"
                  aria-label="Select date"
                  value={resolvedDate}
                  min={minDate || undefined}
                  max={maxDate || undefined}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => navigateDate(1)}
                  disabled={!!maxDate && resolvedDate >= maxDate}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <span className="text-sm font-medium hidden sm:block text-muted-foreground">
                  {formatDateDisplay(resolvedDate)}
                </span>
              </div>

              {/* Track filter */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Track:</span>
                <Select value={selectedTrack} onValueChange={setSelectedTrack}>
                  <SelectTrigger className="w-[160px]">
                    <SelectValue placeholder="All Tracks" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Tracks</SelectItem>
                    {(tracks as Track[]).map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        <div className="flex items-center gap-2">
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: t.color }}
                          />
                          {t.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── Calendar grid ────────────────────────────────────────────────── */}
        <Card>
          <CardContent className="p-0 overflow-hidden rounded-lg">
            <div className="flex">
              {/* Time labels */}
              <div className="w-16 flex-shrink-0 border-r bg-muted/20 select-none">
                {/* Spacer matching track-header height */}
                <div className="h-9 border-b" />
                {TIME_SLOTS.map((slot) => (
                  <div
                    key={slot.hour}
                    className="flex items-start justify-end pr-2 text-xs text-muted-foreground"
                    style={{ height: `${HOUR_HEIGHT}px` }}
                  >
                    <span className="mt-[-9px]">{slot.label}</span>
                  </div>
                ))}
              </div>

              {/* Sessions area */}
              <div className="flex-1 overflow-x-auto">
                {showMultiColumn ? (
                  // Multi-column: one column per track group
                  <div className="flex" style={{ minHeight: `${GRID_HEIGHT + 36}px` }}>
                    {visibleTrackIds.map((tid) => {
                      const track = (tracks as Track[]).find((t) => t.id === tid);
                      const col = sessionsByTrack[tid] || [];
                      return (
                        <div
                          key={tid}
                          className="flex flex-col flex-1 border-r last:border-r-0 min-w-[180px]"
                        >
                          {/* Track header */}
                          <div
                            className="h-9 flex items-center justify-center gap-1.5 border-b text-xs font-medium px-2 shrink-0"
                            style={{
                              backgroundColor: track ? `${track.color}18` : "#f3f4f6",
                            }}
                          >
                            {track && (
                              <div
                                className="w-2.5 h-2.5 rounded-full"
                                style={{ backgroundColor: track.color }}
                              />
                            )}
                            <span>{track?.name || "No Track"}</span>
                          </div>
                          {/* Clickable time area */}
                          <div
                            className={`relative${!isReviewer ? " cursor-crosshair" : ""}`}
                            style={{ height: `${GRID_HEIGHT}px` }}
                            onClick={!isReviewer ? (e) => handleSlotClick(e, tid) : undefined}
                          >
                            {TIME_SLOTS.map((slot, i) => (
                              <div
                                key={slot.hour}
                                className="absolute w-full border-b border-dashed border-muted/60"
                                style={{ top: `${i * HOUR_HEIGHT}px` }}
                              />
                            ))}
                            {col.map((s) => (
                              <SessionCard
                                key={s.id}
                                session={s}
                                style={getSessionStyle(s)}
                                onClick={() => openEditSession(s)}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  // Single column
                  <div>
                    {/* Track header (when a specific track is filtered) */}
                    {selectedTrack !== "all" ? (
                      (() => {
                        const t = (tracks as Track[]).find((t) => t.id === selectedTrack);
                        return (
                          <div
                            className="h-9 flex items-center gap-1.5 px-3 border-b text-xs font-medium"
                            style={{
                              backgroundColor: t ? `${t.color}18` : "#f3f4f6",
                            }}
                          >
                            {t && (
                              <div
                                className="w-2.5 h-2.5 rounded-full"
                                style={{ backgroundColor: t.color }}
                              />
                            )}
                            <span>{t?.name || "No Track"}</span>
                          </div>
                        );
                      })()
                    ) : (
                      <div className="h-9 border-b bg-muted/10 flex items-center px-3">
                        {!isReviewer && (
                          <span className="text-xs text-muted-foreground">
                            Click any time slot to add a session
                          </span>
                        )}
                      </div>
                    )}
                    {/* Clickable time area */}
                    <div
                      className={`relative${!isReviewer ? " cursor-crosshair" : ""}`}
                      style={{ height: `${GRID_HEIGHT}px` }}
                      onClick={!isReviewer ? (e) => handleSlotClick(e) : undefined}
                    >
                      {TIME_SLOTS.map((slot, i) => (
                        <div
                          key={slot.hour}
                          className="absolute w-full border-b border-dashed border-muted/60"
                          style={{ top: `${i * HOUR_HEIGHT}px` }}
                        />
                      ))}
                      {filteredSessions.map((s) => (
                        <SessionCard
                          key={s.id}
                          session={s}
                          style={getSessionStyle(s)}
                          onClick={() => openEditSession(s)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── Session Dialog (Create / Edit) ───────────────────────────────── */}
        <Dialog
          open={isSessionDialogOpen}
          onOpenChange={(open) => {
            setIsSessionDialogOpen(open);
            if (!open) resetSessionForm();
          }}
        >
          <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingSession ? "Edit Session" : "Create Session"}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSessionSubmit} className="space-y-4 pt-1">
              <div className="space-y-1.5">
                <Label>Session Name</Label>
                <Input
                  value={sessionForm.name}
                  onChange={(e) =>
                    setSessionForm({ ...sessionForm, name: e.target.value })
                  }
                  placeholder="e.g. Opening Keynote"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label>Description (optional)</Label>
                <Textarea
                  value={sessionForm.description}
                  onChange={(e) =>
                    setSessionForm({ ...sessionForm, description: e.target.value })
                  }
                  rows={2}
                  placeholder="Brief description…"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Start</Label>
                  <Input
                    type="datetime-local"
                    value={sessionForm.startTime}
                    onChange={(e) =>
                      setSessionForm({ ...sessionForm, startTime: e.target.value })
                    }
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>End</Label>
                  <Input
                    type="datetime-local"
                    value={sessionForm.endTime}
                    onChange={(e) =>
                      setSessionForm({ ...sessionForm, endTime: e.target.value })
                    }
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Track</Label>
                  <Select
                    value={sessionForm.trackId}
                    onValueChange={(v) =>
                      setSessionForm({ ...sessionForm, trackId: v })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      {(tracks as Track[]).map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          <div className="flex items-center gap-2">
                            <div
                              className="w-2.5 h-2.5 rounded-full"
                              style={{ backgroundColor: t.color }}
                            />
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
                    onValueChange={(v) =>
                      setSessionForm({ ...sessionForm, status: v })
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

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Location</Label>
                  <Input
                    value={sessionForm.location}
                    onChange={(e) =>
                      setSessionForm({ ...sessionForm, location: e.target.value })
                    }
                    placeholder="Room or venue"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Capacity</Label>
                  <Input
                    type="number"
                    value={sessionForm.capacity}
                    onChange={(e) =>
                      setSessionForm({ ...sessionForm, capacity: e.target.value })
                    }
                    placeholder="Max attendees"
                    min={1}
                  />
                </div>
              </div>

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
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                            SPEAKER_STATUS_COLORS[sp.status] ?? "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {sp.status}
                        </span>
                      </label>
                    ))}
                  </div>
                  {sessionForm.speakerIds.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {sessionForm.speakerIds.length} speaker
                      {sessionForm.speakerIds.length !== 1 ? "s" : ""} selected
                    </p>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                {editingSession ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-red-500 hover:text-red-600 hover:bg-red-50"
                    onClick={() => handleDeleteSession(editingSession.id)}
                    disabled={deleteSessionMutation.isPending}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    Delete
                  </Button>
                ) : (
                  <div />
                )}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsSessionDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isSaving}>
                    {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {editingSession ? "Save Changes" : "Create Session"}
                  </Button>
                </div>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* ── Track Dialog (Create / Edit) ─────────────────────────────────── */}
        <Dialog
          open={isTrackDialogOpen}
          onOpenChange={(open) => {
            setIsTrackDialogOpen(open);
            if (!open) resetTrackForm();
          }}
        >
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
                  onChange={(e) =>
                    setTrackForm({ ...trackForm, description: e.target.value })
                  }
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
                    onChange={(e) =>
                      setTrackForm({ ...trackForm, color: e.target.value })
                    }
                    className="h-9 w-14 rounded-md border cursor-pointer p-1"
                  />
                  <Input
                    value={trackForm.color}
                    onChange={(e) =>
                      setTrackForm({ ...trackForm, color: e.target.value })
                    }
                    className="flex-1 font-mono text-sm"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsTrackDialogOpen(false)}
                >
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

        {/* ── All Sessions Panel ───────────────────────────────────────────── */}
        <Sheet open={isSessionListOpen} onOpenChange={setIsSessionListOpen}>
          <SheetContent className="w-full sm:max-w-md overflow-y-auto">
            <SheetHeader className="pb-4">
              <SheetTitle className="flex items-center gap-2">
                <List className="h-5 w-5" />
                All Sessions
                <span className="ml-auto text-sm font-normal text-muted-foreground">
                  {stats.total} total
                </span>
              </SheetTitle>
            </SheetHeader>

            {sessionsByDate.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground gap-2">
                <Calendar className="h-10 w-10 opacity-30" />
                <p className="text-sm">No sessions yet</p>
              </div>
            ) : (
              <div className="space-y-6">
                {sessionsByDate.map(([day, daySessions]) => (
                  <div key={day}>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      {formatDateDisplay(day)}
                    </p>
                    <div className="space-y-2">
                      {daySessions.map((s) => (
                        <div
                          key={s.id}
                          className="rounded-lg border bg-card p-3 text-sm space-y-1.5"
                          style={{ borderLeft: `3px solid ${s.track?.color || "#6B7280"}` }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-medium leading-snug">{s.name}</p>
                            <span
                              className={`shrink-0 text-xs px-1.5 py-0.5 rounded-full font-medium ${STATUS_COLORS[s.status] ?? "bg-gray-100 text-gray-700"}`}
                            >
                              {s.status.charAt(0) + s.status.slice(1).toLowerCase()}
                            </span>
                          </div>

                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {formatTime(s.startTime)} – {formatTime(s.endTime)}
                            </span>
                            {s.location && (
                              <span className="flex items-center gap-1">
                                <MapPin className="h-3 w-3" />
                                {s.location}
                              </span>
                            )}
                            {s.speakers.length > 0 && (
                              <span className="flex items-center gap-1">
                                <Users className="h-3 w-3" />
                                {s.speakers
                                  .map(
                                    ({ speaker: sp }) =>
                                      `${sp.firstName} ${sp.lastName}`
                                  )
                                  .join(", ")}
                              </span>
                            )}
                          </div>

                          {s.track && (
                            <div className="flex items-center gap-1.5">
                              <div
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: s.track.color }}
                              />
                              <span className="text-xs text-muted-foreground">
                                {s.track.name}
                              </span>
                            </div>
                          )}

                          {!isReviewer && (
                            <div className="flex gap-2 pt-0.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setIsSessionListOpen(false);
                                  openEditSession(s);
                                }}
                                className="text-xs text-primary hover:underline flex items-center gap-1"
                              >
                                <Edit className="h-3 w-3" />
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteSession(s.id)}
                                className="text-xs text-red-500 hover:underline flex items-center gap-1"
                              >
                                <Trash2 className="h-3 w-3" />
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  );
}

// ── Session Card ─────────────────────────────────────────────────────────────

function SessionCard({
  session,
  style,
  onClick,
}: {
  session: Session;
  style: { top: string; height: string };
  onClick: () => void;
}) {
  const color = session.track?.color || "#6B7280";
  const heightPx = parseInt(style.height);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className="absolute left-1 right-1 rounded text-left overflow-hidden hover:shadow-md hover:z-20 transition-all group/card"
          style={{
            ...style,
            backgroundColor: `${color}18`,
            borderLeft: `3px solid ${color}`,
          }}
        >
          <div className="px-2 py-1">
            <div className="text-xs font-semibold truncate leading-tight">{session.name}</div>
            {heightPx >= 40 && (
              <div className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                {formatTime(session.startTime)} – {formatTime(session.endTime)}
              </div>
            )}
            {heightPx >= 60 && session.location && (
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1 truncate">
                <MapPin className="h-3 w-3 shrink-0" />
                {session.location}
              </div>
            )}
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        <div className="space-y-1.5">
          <div className="font-medium">{session.name}</div>
          <div className="text-xs space-y-1 text-muted-foreground">
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatTime(session.startTime)} – {formatTime(session.endTime)}
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
                {session.speakers
                  .map((s) => `${s.speaker.firstName} ${s.speaker.lastName}`)
                  .join(", ")}
              </div>
            )}
          </div>
          <Badge
            className={`${STATUS_COLORS[session.status]} text-xs`}
            variant="outline"
          >
            {session.status.charAt(0) + session.status.slice(1).toLowerCase()}
          </Badge>
          <p className="text-xs text-muted-foreground italic">Click to edit</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
