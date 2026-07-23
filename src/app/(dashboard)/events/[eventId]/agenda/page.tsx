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
import { MultiSelect } from "@/components/ui/multi-select";
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
  ClipboardList,
  Coffee,
  MapPin,
  Users,
  Utensils,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Link2,
  Copy,
  Check,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { formatPersonName } from "@/lib/utils";
import {
  formatTimeInTz,
  hourFractionInTz,
  localDateInTz,
  localDateTimeInTz,
  resolveTimezone,
  tzLabel,
  wallTimeInTzToDate,
} from "@/lib/event-time";
import {
  SESSION_ROLE_OPTIONS,
  SESSION_STATUS_LABELS,
  SESSION_TYPE_OPTIONS,
  formatSessionRole,
  formatSessionStatus,
  formatSessionType,
  isBreakSessionType,
  sessionStatusColor,
} from "@/lib/session-enums";
import { useSessions, useTracks, useSpeakers, useEvent, queryKeys } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { CSVImportButton } from "@/components/import/csv-import-dialog";
import { ZoomMeetingForm } from "@/components/zoom/zoom-meeting-form";
import { ZoomSessionBadge } from "@/components/zoom/zoom-session-badge";
import { useZoomSettings } from "@/hooks/use-api";
import { SessionDetailSheet } from "@/components/sessions/session-detail-sheet";

// ── Types ────────────────────────────────────────────────────────────────────

interface Track {
  id: string;
  name: string;
  color: string;
}

interface Speaker {
  id: string;
  title?: string | null;
  firstName: string;
  lastName: string;
  status: string;
}

interface SessionSpeakerEntry {
  role: string;
  speaker: Speaker;
}

interface TopicEntry {
  id: string;
  title: string;
  sortOrder: number;
  duration: number | null;
  abstract: { id: string; title: string } | null;
  speakers: Array<{ speaker: Speaker }>;
}

interface ZoomMeetingInfo {
  id: string;
  zoomMeetingId: string;
  meetingType: string;
  status: string;
  joinUrl: string;
  startUrl: string | null;
  passcode: string | null;
  liveStreamEnabled: boolean;
  streamKey: string | null;
  streamStatus: string;
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
  type: string;
  track: Track | null;
  speakers: SessionSpeakerEntry[];
  topics: TopicEntry[];
  zoomMeeting: ZoomMeetingInfo | null;
}

interface TopicForm {
  /** Existing topic id — kept so a session save updates the topic in place
   *  instead of regenerating its id (M2, program/agenda review). */
  id?: string;
  title: string;
  speakerIds: string[];
  duration: string;
}

interface SessionRoleForm {
  speakerId: string;
  role: "SPEAKER" | "MODERATOR" | "CHAIRPERSON" | "PANELIST";
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

const SPEAKER_STATUS_COLORS: Record<string, string> = {
  CONFIRMED: "bg-green-100 text-green-700",
  INVITED: "bg-yellow-100 text-yellow-700",
  DECLINED: "bg-red-100 text-red-700",
};

// Break-item icons on the calendar grid + list. `Users` doubles as the
// speakers icon elsewhere on the page — that's fine, context differs.
const BREAK_TYPE_ICONS: Record<string, LucideIcon> = {
  REGISTRATION: ClipboardList,
  BREAK: Coffee,
  LUNCH: Utensils,
  NETWORKING: Users,
};

// Break items carry no track colour — a fixed muted slate everywhere.
const BREAK_COLOR = "#94a3b8";

const DEFAULT_SESSION_FORM = {
  name: "",
  description: "",
  type: "SESSION",
  trackId: "",
  startTime: "",
  endTime: "",
  location: "",
  capacity: "",
  status: "SCHEDULED",
  speakerIds: [] as string[],
  sessionRoles: [] as SessionRoleForm[],
  topics: [] as TopicForm[],
};

const DEFAULT_TRACK_FORM = { name: "", description: "", color: "#3B82F6" };

// ── Helpers ──────────────────────────────────────────────────────────────────

// Renders an already-timezone-resolved YYYY-MM-DD calendar date. The
// local-midnight parse + local render round-trips to the same calendar
// date in any browser timezone, so this is safe viewer-side.
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

// Grid positions come from the EVENT's clock, not the browser's — this page
// used to mix a browser-local grid with Dubai-fixed list labels (M8,
// program/agenda review), so a travelling organizer built the agenda against
// a mis-drawn grid.
function getSessionStyle(s: Session, timezone: string) {
  const startH = hourFractionInTz(new Date(s.startTime), timezone);
  const endH = hourFractionInTz(new Date(s.endTime), timezone);
  const top = (startH - START_HOUR) * HOUR_HEIGHT;
  const height = Math.max((endH - startH) * HOUR_HEIGHT, 28);
  return { top: `${top}px`, height: `${height}px` };
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function AgendaPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const queryClient = useQueryClient();
  const { data: authSession } = useSession();
  const isReviewer =
    authSession?.user?.role === "REVIEWER" ||
    authSession?.user?.role === "SUBMITTER";

  const [copied, setCopied] = useState(false);
  const [detailSheetOpen, setDetailSheetOpen] = useState(false);
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null);

  const { data: event } = useEvent(eventId);
  const { data: sessions = [], isLoading: loading, isFetching, refetch: refetchSessions } = useSessions(eventId);
  const { data: tracks = [], refetch: refetchTracks } = useTracks(eventId);
  const { data: speakers = [] } = useSpeakers(eventId);
  const { data: zoomSettings } = useZoomSettings(eventId);
  const isZoomEnabled = zoomSettings?.enabled === true;

  const handleRefresh = () => {
    refetchSessions();
    refetchTracks();
  };

  // Everything on this page — day buckets, grid positions, time labels, the
  // session form — operates in the EVENT's timezone.
  const eventTz = resolveTimezone(event?.timezone);

  // Event date boundaries (YYYY-MM-DD, event-local)
  const minDate = event?.startDate ? localDateInTz(new Date(event.startDate), eventTz) : "";
  const maxDate = event?.endDate ? localDateInTz(new Date(event.endDate), eventTz) : "";

  // null = not yet chosen by user; resolves to event start date once loaded
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const resolvedDate = selectedDate ?? (minDate || localDateInTz(new Date(), eventTz));
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
      if (!res.ok) {
        // Surface the server's reason (BREAK_ITEM_HAS_PROGRAM, STALE_WRITE,
        // OUTSIDE_EVENT_DATES, …) instead of a generic failure (review M4).
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || "Failed to save session");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions(eventId) });
      setIsSessionDialogOpen(false);
      resetSessionForm();
      toast.success(editingSession ? "Session updated" : "Session created");
    },
    onError: (error: Error) => toast.error(error.message || "Failed to save session"),
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
    const { sessionRoles, topics, speakerIds, ...rest } = sessionForm;
    const breakItem = isBreakSessionType(rest.type);

    // Use sessionRoles if any exist; otherwise fall back to legacy speakerIds
    const hasRoles = !breakItem && sessionRoles.length > 0;
    const hasLegacySpeakers = !breakItem && speakerIds.length > 0;

    sessionMutation.mutate({
      data: {
        name: rest.name,
        description: rest.description || undefined,
        type: rest.type,
        // Break items are deliberately track-less (they render as a
        // full-width band, not inside a track column). On edit, `null`
        // clears a track left over from before the conversion.
        trackId: breakItem
          ? editingSession
            ? null
            : undefined
          : rest.trackId || undefined,
        // Same clear for a leftover abstract link (review M4) and capacity
        // (review L2) — a break item keeps neither.
        ...(breakItem && editingSession ? { abstractId: null } : {}),
        capacity: breakItem
          ? editingSession
            ? null
            : undefined
          : rest.capacity
            ? parseInt(rest.capacity)
            : undefined,
        // The datetime-local values are wall-clock times in the EVENT's
        // timezone (that's how the form displays them), so they must be
        // interpreted in that zone — not the browser's.
        startTime: wallTimeInTzToDate(rest.startTime, eventTz).toISOString(),
        endTime: wallTimeInTzToDate(rest.endTime, eventTz).toISOString(),
        location: rest.location || undefined,
        status: rest.status,
        // A break item always submits empty lists — the server refuses a
        // break item that would end up with speakers/topics, and this is
        // the explicit clear when converting an existing session.
        ...(hasRoles
          ? { sessionRoles }
          : hasLegacySpeakers
            ? { speakerIds }
            : { sessionRoles: [] }),
        topics: !breakItem && topics.length > 0
          ? topics.map((t, i) => ({
              ...(t.id ? { id: t.id } : {}),
              title: t.title,
              duration: t.duration ? parseInt(t.duration) : undefined,
              sortOrder: i,
              speakerIds: t.speakerIds,
            }))
          : [],
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
    // Show stored instants as wall-clock times in the event's timezone —
    // matching how the grid draws them and how submit re-interprets them.
    const toLocal = (iso: string) => localDateTimeInTz(new Date(iso), eventTz);
    setSessionForm({
      name: s.name,
      description: s.description || "",
      type: s.type || "SESSION",
      trackId: s.track?.id || "",
      startTime: toLocal(s.startTime),
      endTime: toLocal(s.endTime),
      location: s.location || "",
      capacity: s.capacity?.toString() || "",
      status: s.status,
      speakerIds: [],
      sessionRoles: s.speakers.map((sp) => ({
        speakerId: sp.speaker.id,
        role: sp.role as SessionRoleForm["role"],
      })),
      topics: (s.topics || []).map((t) => ({
        id: t.id,
        title: t.title,
        speakerIds: t.speakers.map((ts) => ts.speaker.id),
        duration: t.duration?.toString() || "",
      })),
    });
    setIsSessionDialogOpen(true);
  };

  const openEditTrack = (t: Track) => {
    setEditingTrack(t);
    setTrackForm({ name: t.name, description: "", color: t.color });
    setIsTrackDialogOpen(true);
  };

  const openAddSession = () => {
    setEditingSession(null);
    setSessionForm({
      ...DEFAULT_SESSION_FORM,
      startTime: `${resolvedDate}T09:00`,
      endTime: `${resolvedDate}T10:00`,
    });
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
    // Pure calendar-date arithmetic on the YYYY-MM-DD string — UTC parse +
    // UTC render keeps it independent of the browser timezone.
    const d = new Date(resolvedDate + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + dir);
    const next = d.toISOString().slice(0, 10);
    if (minDate && next < minDate) return;
    if (maxDate && next > maxDate) return;
    setSelectedDate(next);
  };

  // ── Derived data ──────────────────────────────────────────────────────────

  const filteredSessions = useMemo(() => {
    return (sessions as Session[]).filter((s) => {
      const sd = localDateInTz(new Date(s.startTime), eventTz);
      const matchDate = sd === resolvedDate;
      // Break items span the whole event, so they show under ANY track filter.
      const matchTrack =
        selectedTrack === "all" ||
        isBreakSessionType(s.type) ||
        s.track?.id === selectedTrack;
      return matchDate && matchTrack;
    });
  }, [sessions, resolvedDate, selectedTrack, eventTz]);

  const sessionsByTrack = useMemo(() => {
    const grouped: Record<string, Session[]> = {};
    filteredSessions.forEach((s) => {
      // Break items are excluded from track grouping: they carry no track by
      // design, and grouping them used to sprout a phantom "No Track" column
      // the moment a coffee break was added to a fully-tracked agenda. They
      // render as full-width bands spanning all columns instead (dayBreaks).
      if (isBreakSessionType(s.type)) return;
      const tid = s.track?.id || "no-track";
      (grouped[tid] ??= []).push(s);
    });
    return grouped;
  }, [filteredSessions]);

  const dayBreaks = useMemo(
    () => filteredSessions.filter((s) => isBreakSessionType(s.type)),
    [filteredSessions]
  );

  // Track group IDs visible on this day (for multi-column layout)
  const visibleTrackIds = useMemo(
    () => (selectedTrack === "all" ? Object.keys(sessionsByTrack) : []),
    [selectedTrack, sessionsByTrack]
  );

  const showMultiColumn = selectedTrack === "all" && visibleTrackIds.length > 1;

  const allEventDates = useMemo(() => {
    const s = new Set<string>();
    (sessions as Session[]).forEach((sess) =>
      s.add(localDateInTz(new Date(sess.startTime), eventTz))
    );
    return s.size;
  }, [sessions, eventTz]);

  // The Sessions/Scheduled tiles count real program sessions only — break
  // items (registration/coffee/lunch) are agenda furniture, not sessions.
  const programSessions = useMemo(
    () => (sessions as Session[]).filter((s) => !isBreakSessionType(s.type)),
    [sessions]
  );

  const stats = {
    total: programSessions.length,
    scheduled: programSessions.filter((s) => s.status === "SCHEDULED").length,
    tracks: (tracks as Track[]).length,
    days: allEventDates,
  };

  // Sessions grouped by date for the list panel
  const sessionsByDate = useMemo(() => {
    const map: Record<string, Session[]> = {};
    (sessions as Session[]).forEach((s) => {
      const day = localDateInTz(new Date(s.startTime), eventTz);
      (map[day] ??= []).push(s);
    });
    // Sort each day's sessions by start time
    Object.values(map).forEach((arr) =>
      arr.sort(
        (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
      )
    );
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [sessions, eventTz]);

  // Break items (registration / coffee / lunch / networking) are plain time
  // blocks: the form hides the track, capacity, roles, topics and Zoom
  // sections for them, and the submit clears any leftovers on conversion.
  const isBreakForm = isBreakSessionType(sessionForm.type);

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
                Agenda
                {isFetching && !loading && (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                )}
              </h1>
            </div>
            <p className="text-muted-foreground text-sm ml-6">
              {isReviewer
                ? "View the event agenda"
                : "Click any time slot to add a session · Click a session to edit"}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="icon"
              onClick={handleRefresh}
              disabled={isFetching}
              title="Refresh data"
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
            {!isReviewer && (
              <>
                <CSVImportButton eventId={eventId} entityType="sessions" />
                <Button variant="outline" size="sm" onClick={openAddTrack}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  Add Track
                </Button>
                <Button size="sm" onClick={openAddSession}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  Add Session
                </Button>
              </>
            )}
          </div>
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

        {/* ── Public agenda URL ───────────────────────────────────────────── */}
        {!isReviewer && event?.slug && (
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border bg-muted/40">
            <Link2 className="h-4 w-4 text-primary shrink-0" />
            <span className="text-xs text-muted-foreground font-medium shrink-0">Public agenda:</span>
            <code className="flex-1 text-xs font-mono truncate select-all">
              {process.env.NEXT_PUBLIC_APP_URL || ""}/e/{event.slug}/agenda
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 h-7 px-2.5"
              onClick={() => {
                const url = `${window.location.origin}/e/${event.slug}/agenda`;
                navigator.clipboard.writeText(url).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? (
                <><Check className="h-3.5 w-3.5 mr-1 text-green-600" /> Copied</>
              ) : (
                <><Copy className="h-3.5 w-3.5 mr-1" /> Copy</>
              )}
            </Button>
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
                  {(() => {
                    const lbl = tzLabel(new Date(resolvedDate + "T12:00:00Z"), eventTz);
                    return lbl ? ` · ${lbl}` : "";
                  })()}
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
                  // Multi-column: one column per track group. Break items are
                  // NOT columns — they overlay as full-width bands below.
                  <div className="relative">
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
                                timezone={eventTz}
                                style={getSessionStyle(s, eventTz)}
                                onClick={() => openEditSession(s)}
                                onViewDetails={() => { setDetailSessionId(s.id); setDetailSheetOpen(true); }}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Break bands: full width across ALL track columns, offset
                      past the 36px track headers. z-[5] keeps them above the
                      column backgrounds but below session cards (z-10), so an
                      overlapping workshop stays visible + clickable. */}
                  {dayBreaks.map((s) => (
                    <BreakBand
                      key={s.id}
                      session={s}
                      timezone={eventTz}
                      headerOffset={36}
                      onClick={() => openEditSession(s)}
                    />
                  ))}
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
                          timezone={eventTz}
                          style={getSessionStyle(s, eventTz)}
                          onClick={() => openEditSession(s)}
                          onViewDetails={() => { setDetailSessionId(s.id); setDetailSheetOpen(true); }}
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
          <DialogContent className="sm:max-w-[90vw] lg:min-w-[750px] lg:max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingSession
                  ? isBreakForm ? "Edit Break Item" : "Edit Session"
                  : isBreakForm ? "Add Break Item" : "Create Session"}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSessionSubmit} className="space-y-4 pt-1">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <Select
                    value={sessionForm.type}
                    onValueChange={(v) =>
                      setSessionForm({ ...sessionForm, type: v })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SESSION_TYPE_OPTIONS.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isBreakForm && (
                    <p className="text-xs text-muted-foreground">
                      A break item is a plain agenda time block — no speakers,
                      topics, or track.
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>{isBreakForm ? "Name" : "Session Name"}</Label>
                  <Input
                    value={sessionForm.name}
                    onChange={(e) =>
                      setSessionForm({ ...sessionForm, name: e.target.value })
                    }
                    placeholder={isBreakForm ? "e.g. Morning Coffee Break" : "e.g. Opening Keynote"}
                    required
                  />
                </div>
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
                    min={minDate ? `${minDate}T00:00` : undefined}
                    max={maxDate ? `${maxDate}T23:59` : undefined}
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
                    min={minDate ? `${minDate}T00:00` : undefined}
                    max={maxDate ? `${maxDate}T23:59` : undefined}
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {!isBreakForm && (
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
                )}
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
                      {Object.entries(SESSION_STATUS_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
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
                    placeholder={isBreakForm ? "e.g. Foyer" : "Room or venue"}
                  />
                </div>
                {!isBreakForm && (
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
                )}
              </div>

              {/* Session Roles (Moderator, Chairperson, Panelist, Speaker) */}
              {!isBreakForm && (speakers as Speaker[]).length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Session Roles</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() =>
                        setSessionForm({
                          ...sessionForm,
                          sessionRoles: [
                            ...sessionForm.sessionRoles,
                            { speakerId: "", role: "SPEAKER" },
                          ],
                        })
                      }
                    >
                      <Plus className="mr-1 h-3 w-3" /> Add Role
                    </Button>
                  </div>
                  {sessionForm.sessionRoles.length === 0 && (
                    <p className="text-xs text-muted-foreground">No session roles assigned. Add moderators, chairpersons, panelists, or speakers.</p>
                  )}
                  <div className="space-y-2">
                    {sessionForm.sessionRoles.map((sr, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <Select
                          value={sr.role}
                          onValueChange={(v) => {
                            const updated = [...sessionForm.sessionRoles];
                            updated[idx] = { ...updated[idx], role: v as SessionRoleForm["role"] };
                            setSessionForm({ ...sessionForm, sessionRoles: updated });
                          }}
                        >
                          <SelectTrigger className="w-[140px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SESSION_ROLE_OPTIONS.map((r) => (
                              <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={sr.speakerId}
                          onValueChange={(v) => {
                            const updated = [...sessionForm.sessionRoles];
                            updated[idx] = { ...updated[idx], speakerId: v };
                            setSessionForm({ ...sessionForm, sessionRoles: updated });
                          }}
                        >
                          <SelectTrigger className="flex-1">
                            <SelectValue placeholder="Select speaker" />
                          </SelectTrigger>
                          <SelectContent>
                            {(speakers as Speaker[]).map((sp) => (
                              <SelectItem key={sp.id} value={sp.id}>
                                {sp.firstName} {sp.lastName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-500 hover:text-red-600 shrink-0"
                          onClick={() => {
                            const updated = sessionForm.sessionRoles.filter((_, i) => i !== idx);
                            setSessionForm({ ...sessionForm, sessionRoles: updated });
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Topics (optional) */}
              {!isBreakForm && (speakers as Speaker[]).length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Topics</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() =>
                        setSessionForm({
                          ...sessionForm,
                          topics: [
                            ...sessionForm.topics,
                            { title: "", speakerIds: [], duration: "" },
                          ],
                        })
                      }
                    >
                      <Plus className="mr-1 h-3 w-3" /> Add Topic
                    </Button>
                  </div>
                  {sessionForm.topics.length === 0 && (
                    <p className="text-xs text-muted-foreground">No topics. Add topics to assign speakers per presentation.</p>
                  )}
                  <div className="space-y-3">
                    {sessionForm.topics.map((topic, idx) => (
                      <div key={idx} className="border rounded-lg p-3 space-y-2 bg-muted/30">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-muted-foreground w-5 shrink-0">#{idx + 1}</span>
                          <Input
                            value={topic.title}
                            onChange={(e) => {
                              const updated = [...sessionForm.topics];
                              updated[idx] = { ...updated[idx], title: e.target.value };
                              setSessionForm({ ...sessionForm, topics: updated });
                            }}
                            placeholder="Topic title"
                            className="flex-1"
                          />
                          <Input
                            type="number"
                            value={topic.duration}
                            onChange={(e) => {
                              const updated = [...sessionForm.topics];
                              updated[idx] = { ...updated[idx], duration: e.target.value };
                              setSessionForm({ ...sessionForm, topics: updated });
                            }}
                            placeholder="Min"
                            className="w-16"
                            min={1}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-red-500 hover:text-red-600 shrink-0"
                            onClick={() => {
                              const updated = sessionForm.topics.filter((_, i) => i !== idx);
                              setSessionForm({ ...sessionForm, topics: updated });
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <div className="pl-5">
                          <MultiSelect
                            options={(speakers as Speaker[]).map((sp) => ({
                              value: sp.id,
                              label: `${sp.firstName} ${sp.lastName}`,
                              badge: sp.status,
                              badgeClassName: SPEAKER_STATUS_COLORS[sp.status] ?? "bg-gray-100 text-gray-700",
                            }))}
                            selected={topic.speakerIds}
                            onChange={(selected) => {
                              const updated = [...sessionForm.topics];
                              updated[idx] = { ...updated[idx], speakerIds: selected };
                              setSessionForm({ ...sessionForm, topics: updated });
                            }}
                            placeholder="Select speakers..."
                            searchPlaceholder="Search speakers..."
                            emptyMessage="No speakers found."
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Zoom Integration — never on a break item */}
              {editingSession && isZoomEnabled && !isReviewer && !isBreakForm && (
                <div className="space-y-2 pt-2 border-t">
                  <Label className="text-sm font-medium">Zoom</Label>
                  <ZoomMeetingForm
                    eventId={eventId}
                    sessionId={editingSession.id}
                    sessionName={editingSession.name}
                    hasZoomMeeting={!!editingSession.zoomMeeting}
                    zoomMeetingType={editingSession.zoomMeeting?.meetingType}
                    zoomJoinUrl={editingSession.zoomMeeting?.joinUrl}
                    zoomStartUrl={editingSession.zoomMeeting?.startUrl || undefined}
                    zoomMeetingId={editingSession.zoomMeeting?.zoomMeetingId}
                    zoomPasscode={editingSession.zoomMeeting?.passcode || undefined}
                    zoomLiveStreamEnabled={editingSession.zoomMeeting?.liveStreamEnabled}
                    zoomStreamKey={editingSession.zoomMeeting?.streamKey || undefined}
                    zoomStreamStatus={editingSession.zoomMeeting?.streamStatus}
                    eventSlug={event?.slug}
                    defaultMeetingType={zoomSettings?.defaultMeetingType || "MEETING"}
                    onCreated={async () => {
                      const { data } = await refetchSessions();
                      const updated = data?.find((s: Session) => s.id === editingSession.id);
                      if (updated) setEditingSession(updated);
                    }}
                    onDeleted={async () => {
                      const { data } = await refetchSessions();
                      const updated = data?.find((s: Session) => s.id === editingSession.id);
                      if (updated) setEditingSession(updated);
                    }}
                  />
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
          <SheetContent className="w-full px-6 sm:max-w-[700px] overflow-y-auto">
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
                          style={{
                            borderLeft: `3px solid ${isBreakSessionType(s.type) ? BREAK_COLOR : s.track?.color || "#6B7280"}`,
                          }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-medium leading-snug">{s.name}</p>
                            <span
                              className={`shrink-0 text-xs px-1.5 py-0.5 rounded-full font-medium ${isBreakSessionType(s.type) ? "bg-slate-100 text-slate-600" : sessionStatusColor(s.status)}`}
                            >
                              {isBreakSessionType(s.type)
                                ? formatSessionType(s.type)
                                : formatSessionStatus(s.status)}
                            </span>
                          </div>

                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {formatTimeInTz(new Date(s.startTime), eventTz)} –{" "}
                              {formatTimeInTz(new Date(s.endTime), eventTz)}
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

                          {s.zoomMeeting && (
                            <ZoomSessionBadge
                              meetingType={s.zoomMeeting.meetingType}
                              status={s.zoomMeeting.status}
                            />
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

      <SessionDetailSheet
        eventId={eventId}
        sessionId={detailSessionId}
        timezone={eventTz}
        open={detailSheetOpen}
        onOpenChange={setDetailSheetOpen}
        onSessionUpdated={() => {
          queryClient.invalidateQueries({ queryKey: queryKeys.sessions(eventId) });
        }}
      />
    </TooltipProvider>
  );
}

// ── Session Card ─────────────────────────────────────────────────────────────

/** A break item on the multi-column grid: one full-width band spanning every
 *  track column (a coffee break belongs to the whole event, not one track).
 *  Replaces the old behavior where a trackless break minted a phantom
 *  "No Track" column. Styling mirrors SessionCard's break look. */
function BreakBand({
  session,
  timezone,
  headerOffset,
  onClick,
}: {
  session: Session;
  timezone: string;
  headerOffset: number;
  onClick: () => void;
}) {
  const BreakIcon = BREAK_TYPE_ICONS[session.type] ?? Coffee;
  const style = getSessionStyle(session, timezone);
  const top = headerOffset + parseFloat(style.top);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="absolute left-0 right-0 z-[5] rounded border border-dashed border-slate-300 text-left overflow-hidden hover:shadow-md transition-all"
      style={{
        top: `${top}px`,
        height: style.height,
        backgroundColor: `${BREAK_COLOR}18`,
        borderLeft: `3px solid ${BREAK_COLOR}`,
      }}
    >
      <div className="px-3 h-full flex items-center gap-2">
        <BreakIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        <span className="text-xs font-semibold text-slate-600 truncate">{session.name}</span>
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
          {formatTimeInTz(new Date(session.startTime), timezone)} –{" "}
          {formatTimeInTz(new Date(session.endTime), timezone)}
        </span>
      </div>
    </button>
  );
}

function SessionCard({
  session,
  timezone,
  style,
  onClick,
  onViewDetails,
}: {
  session: Session;
  timezone: string;
  style: { top: string; height: string };
  onClick: () => void;
  onViewDetails?: () => void;
}) {
  const isBreak = isBreakSessionType(session.type);
  const color = isBreak ? BREAK_COLOR : session.track?.color || "#6B7280";
  const BreakIcon = isBreak ? BREAK_TYPE_ICONS[session.type] : null;
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
          className={`absolute left-1 right-1 z-10 rounded text-left overflow-hidden hover:shadow-md hover:z-20 transition-all group/card${isBreak ? " border border-dashed border-slate-300" : ""}`}
          style={{
            ...style,
            backgroundColor: `${color}18`,
            borderLeft: `3px solid ${color}`,
          }}
        >
          <div className="px-2 py-1">
            <div className="text-xs font-semibold truncate leading-tight flex items-center gap-1">
              {BreakIcon && <BreakIcon className="h-3 w-3 shrink-0 text-slate-500" />}
              <span className={isBreak ? "text-slate-600" : undefined}>{session.name}</span>
            </div>
            {heightPx >= 40 && (
              <div className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                {formatTimeInTz(new Date(session.startTime), timezone)} –{" "}
                {formatTimeInTz(new Date(session.endTime), timezone)}
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
              {formatTimeInTz(new Date(session.startTime), timezone)} –{" "}
              {formatTimeInTz(new Date(session.endTime), timezone)}
            </div>
            {session.location && (
              <div className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {session.location}
              </div>
            )}
            {!isBreak && session.capacity && (
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
            {session.zoomMeeting && (
              <ZoomSessionBadge
                meetingType={session.zoomMeeting.meetingType}
                status={session.zoomMeeting.status}
              />
            )}
            {session.speakers.length > 0 && (
              <div className="space-y-0.5">
                {session.speakers.map((s, i) => (
                  <div key={i}>
                    <span className="font-medium text-foreground/80">{s.role !== "SPEAKER" ? `${formatSessionRole(s.role)}: ` : ""}</span>
                    {formatPersonName(s.speaker.title, s.speaker.firstName, s.speaker.lastName)}
                  </div>
                ))}
              </div>
            )}
            {session.topics?.length > 0 && (
              <div className="border-t border-border/50 pt-1 mt-1 space-y-0.5">
                {session.topics.map((t) => (
                  <div key={t.id} className="text-xs">
                    <span className="font-medium text-foreground/80">{t.title}</span>
                    {t.speakers.length > 0 && (
                      <span> — {t.speakers.map((ts) => formatPersonName(ts.speaker.title, ts.speaker.firstName, ts.speaker.lastName)).join(", ")}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <Badge
            className={`${isBreak ? "bg-slate-100 text-slate-600" : sessionStatusColor(session.status)} text-xs`}
            variant="outline"
          >
            {isBreak ? formatSessionType(session.type) : formatSessionStatus(session.status)}
          </Badge>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="italic">Click to edit</span>
            {onViewDetails && !isBreak && (
              <>
                <span>·</span>
                <button
                  type="button"
                  className="text-primary hover:underline font-medium not-italic"
                  onClick={(e) => { e.stopPropagation(); onViewDetails(); }}
                >
                  View Details
                </button>
              </>
            )}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
