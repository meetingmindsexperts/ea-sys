"use client";

import { useState, useEffect, useMemo } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  Calendar,
  ClipboardList,
  Coffee,
  MapPin,
  Users,
  Utensils,
  Printer,
  ArrowLeft,
  Loader2,
  ChevronRight,
  Clock,
  Mail,
  type LucideIcon,
} from "lucide-react";
import { cn, formatPersonName } from "@/lib/utils";
import { EventBanner } from "@/components/public/event-banner";
import {
  formatEventDateRange,
  formatTimeInTz,
  localDateInTz,
  resolveTimezone,
  tzLabel,
} from "@/lib/event-time";
import {
  formatSessionRole,
  formatSessionType,
  isBreakSessionType,
  sessionNeedsTba,
  topicNeedsTba,
  TBA_LABEL,
} from "@/lib/session-enums";
import { buildAgendaRows, type AgendaRow } from "@/lib/agenda-layout";

// ── Types ──────────────────────────────────────────────────────────────────

interface Track {
  id: string;
  name: string;
  color: string;
}

interface Speaker {
  id: string;
  title: string | null;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  organization: string | null;
  photo: string | null;
}

interface TopicSpeaker {
  id: string;
  title: string | null;
  firstName: string;
  lastName: string;
}

interface Topic {
  id: string;
  title: string;
  duration: number | null;
  sortOrder: number;
  speakers: Array<{ speaker: TopicSpeaker }>;
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
  type?: string;
  track: Track | null;
  speakers: Array<{ role: string; speaker: Speaker }>;
  topics: Topic[];
}

// Break items (registration desk / coffee / lunch / networking) render as a
// slim band instead of a full session card.
const BREAK_TYPE_ICONS: Record<string, LucideIcon> = {
  REGISTRATION: ClipboardList,
  BREAK: Coffee,
  LUNCH: Utensils,
  NETWORKING: Users,
};

// Soft per-type accent (icon chip tint + left border) so each break kind is
// recognizable at a glance without competing with the session cards.
const BREAK_TYPE_ACCENTS: Record<string, { chip: string; icon: string; border: string }> = {
  REGISTRATION: { chip: "bg-sky-100", icon: "text-sky-600", border: "#38bdf8" },
  BREAK: { chip: "bg-amber-100", icon: "text-amber-600", border: "#fbbf24" },
  LUNCH: { chip: "bg-emerald-100", icon: "text-emerald-600", border: "#34d399" },
  NETWORKING: { chip: "bg-violet-100", icon: "text-violet-600", border: "#a78bfa" },
};

interface EventData {
  id: string;
  name: string;
  slug: string;
  startDate: string;
  endDate: string;
  timezone: string;
  supportEmail: string | null;
  bannerImage: string | null;
  bannerImageMobile: string | null;
  organization: { name: string; logo: string | null };
  tracks: Track[];
  sessions: Session[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDateHeading(dateStr: string) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** "Fri, Oct 2" — the sub-label under a day tab. */
function formatDayTabDate(dateStr: string) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function getDurationMin(start: string, end: string) {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
}

/**
 * Per-topic start–end times computed by stacking topic durations from the
 * session start (SessionTopic stores no start time). SAME convention as the
 * {{moderatorDetails}} run-sheet in speaker-agreement.ts: a topic with no
 * duration shows no time range and does NOT advance the clock.
 */
function computeTopicTimes(
  sessionStart: string,
  topics: Topic[],
  timezone: string,
): Map<string, string | null> {
  const times = new Map<string, string | null>();
  let clock = new Date(sessionStart).getTime();
  for (const topic of topics) {
    if (topic.duration && topic.duration > 0) {
      const start = new Date(clock);
      const end = new Date(clock + topic.duration * 60_000);
      times.set(topic.id, `${formatTimeInTz(start, timezone)} – ${formatTimeInTz(end, timezone)}`);
      clock = end.getTime();
    } else {
      times.set(topic.id, null);
    }
  }
  return times;
}

// ── Main Page ─────────────────────────────────────────────────────────────

export default function PublicAgendaPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [eventData, setEventData] = useState<EventData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<string>("all");

  useEffect(() => {
    async function fetchAgenda() {
      try {
        const res = await fetch(`/api/public/events/${slug}/agenda`);
        if (!res.ok) {
          setError(res.status === 404 ? "Event not found or not yet published" : "Failed to load agenda");
          return;
        }
        const data: EventData = await res.json();
        setEventData(data);
      } catch (err) {
        console.error("[agenda] Failed to load agenda:", err);
        setError("Failed to load agenda");
      } finally {
        setLoading(false);
      }
    }
    if (slug) fetchAgenda();
  }, [slug]);

  // Group sessions by date — the EVENT's local date, not the viewer's.
  // Times below render in the event timezone, so the day buckets must use
  // the same clock or an 11 PM session lands under the wrong heading for
  // any viewer west of the event (M7, program/agenda review).
  const sessionsByDate = useMemo(() => {
    if (!eventData) return [];
    const map: Record<string, Session[]> = {};
    eventData.sessions.forEach((s) => {
      const day = localDateInTz(new Date(s.startTime), resolveTimezone(eventData.timezone));
      (map[day] ??= []).push(s);
    });
    Object.values(map).forEach((arr) =>
      arr.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    );
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [eventData]);

  const allDates = sessionsByDate.map(([d]) => d);

  // Resolve selected date
  const resolvedDate = selectedDate ?? allDates[0] ?? null;

  // Sessions to display (filtered by date + track)
  const visibleSessions = useMemo(() => {
    if (!resolvedDate) return [];
    const daySessions = sessionsByDate.find(([d]) => d === resolvedDate)?.[1] ?? [];
    if (selectedTrack === "all") return daySessions;
    return daySessions.filter((s) => s.track?.id === selectedTrack);
  }, [sessionsByDate, resolvedDate, selectedTrack]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="text-slate-400 text-sm tracking-wide">Loading agenda…</p>
        </div>
      </div>
    );
  }

  if (error || !eventData) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-10 w-full max-w-lg text-center">
          <div className="mx-auto mb-5 h-16 w-16 rounded-full bg-slate-100 flex items-center justify-center">
            <Clock className="h-8 w-8 text-slate-400" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">
            Agenda Not Live Yet
          </h2>
          <p className="text-slate-500 text-sm leading-relaxed mb-6 max-w-sm mx-auto">
            The agenda for this event hasn&apos;t been published yet.
            Please check back later — it will be available here once the organizer publishes it.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link href={`/e/${slug}`}>
              <button type="button" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to event
              </button>
            </Link>
            {eventData?.supportEmail && (
              <>
                <span className="hidden sm:inline text-slate-300">|</span>
                <a
                  href={`mailto:${eventData.supportEmail}`}
                  className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
                >
                  <Mail className="h-3.5 w-3.5" />
                  Contact support
                </a>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 print:bg-white">
      {/* ── Event branding banner (same art-directed image as the other
             public pages; hidden in print to save ink) ──────────────────── */}
      {eventData.bannerImage && (
        <div className="relative w-full bg-white print:hidden">
          <div className="max-w-5xl mx-auto">
            <EventBanner
              banner={eventData.bannerImage}
              bannerMobile={eventData.bannerImageMobile}
              name={eventData.name}
              className="block w-full h-auto"
              priority
            />
          </div>
        </div>
      )}

      {/* ── Header — light strip (the dark hero band was dropped on organizer
             request; the banner above carries the branding). Doubles as the
             print header (event name + dates). ─────────────────────────── */}
      <div className="bg-white border-b border-slate-100 print:border-slate-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 print:py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-primary text-sm font-semibold tracking-widest uppercase mb-1">
                Agenda
              </p>
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900">
                {eventData.name}
              </h1>
              <div className="flex items-center gap-1.5 mt-2 text-sm text-slate-500">
                <Calendar className="h-3.5 w-3.5" />
                <span>
                  {formatEventDateRange(
                    new Date(eventData.startDate),
                    new Date(eventData.endDate),
                    eventData.timezone,
                  )}
                </span>
              </div>
            </div>

            {/* Print button. Icon-only on phones, where the label costs more
                width than the event title can spare; the accessible name stays
                on the button so it is never an unlabelled icon. */}
            <button
              type="button"
              onClick={() => window.print()}
              aria-label="Print or save the agenda as a PDF"
              title="Print / Save PDF"
              className="shrink-0 flex items-center justify-center sm:gap-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-sm font-medium h-10 w-10 sm:h-auto sm:w-auto sm:px-4 sm:py-2 rounded-xl shadow-sm transition-colors print:hidden"
            >
              <Printer className="h-4 w-4" />
              <span className="hidden sm:inline">Print / Save PDF</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Filters (hidden when printing) ───────────────────────────────────
             Two levels, not one row of equal pills: the day is the first thing
             an attendee picks on a multi-day programme, and the track is a
             refinement within it. Both sat side by side before, which read as
             two filters of equal weight. */}
      {(allDates.length > 1 || eventData.tracks.length > 0) && (
        <div className="bg-white border-b border-slate-100 print:hidden">
          {/* Day tabs — the primary control. Only ever shown when there is a
              genuine choice to make. */}
          {allDates.length > 1 && (
            <div className="max-w-5xl mx-auto px-4 sm:px-6">
              <div className="flex items-end gap-1 overflow-x-auto">
                {allDates.map((d, i) => {
                  const active = resolvedDate === d && selectedDate !== null;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setSelectedDate(d)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "shrink-0 border-b-2 px-4 pt-3 pb-2.5 text-left transition-colors",
                        active
                          ? "border-primary"
                          : "border-transparent hover:border-slate-200",
                      )}
                    >
                      <span
                        className={cn(
                          "block text-sm font-bold",
                          active ? "text-primary" : "text-slate-700",
                        )}
                      >
                        Day {i + 1}
                      </span>
                      <span
                        className={cn(
                          "block text-xs",
                          active ? "text-primary/70" : "text-slate-400",
                        )}
                      >
                        {formatDayTabDate(d)}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setSelectedDate(null)}
                  aria-current={selectedDate === null ? "true" : undefined}
                  className={cn(
                    "shrink-0 border-b-2 px-4 pt-3 pb-2.5 text-left transition-colors",
                    selectedDate === null
                      ? "border-primary"
                      : "border-transparent hover:border-slate-200",
                  )}
                >
                  <span
                    className={cn(
                      "block text-sm font-bold",
                      selectedDate === null ? "text-primary" : "text-slate-700",
                    )}
                  >
                    All Days
                  </span>
                  <span
                    className={cn(
                      "block text-xs",
                      selectedDate === null ? "text-primary/70" : "text-slate-400",
                    )}
                  >
                    {allDates.length} days
                  </span>
                </button>
              </div>
            </div>
          )}

          {/* Track filter — the secondary row, set on a tinted strip so it
              reads as a refinement of the day above rather than a peer of it. */}
          {eventData.tracks.length > 0 && (
            <div
              className={cn(
                "bg-slate-50/80",
                allDates.length > 1 && "border-t border-slate-100",
              )}
            >
              <div className="max-w-5xl mx-auto px-4 sm:px-6 py-2.5 flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-semibold tracking-widest uppercase text-slate-400 mr-1">
                  Track
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedTrack("all")}
                  className={cn(
                    "px-3 py-1 rounded-lg text-sm font-medium transition-colors",
                    selectedTrack === "all"
                      ? "bg-slate-800 text-white"
                      : "text-slate-600 hover:bg-slate-200/70",
                  )}
                >
                  All
                </button>
                {eventData.tracks.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedTrack(t.id)}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1 rounded-lg text-sm font-medium transition-all border",
                      selectedTrack === t.id
                        ? "text-white"
                        : "bg-white text-slate-600 hover:bg-slate-100",
                    )}
                    style={
                      selectedTrack === t.id
                        ? { backgroundColor: t.color, borderColor: t.color }
                        : { borderColor: `${t.color}40` }
                    }
                  >
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: selectedTrack === t.id ? "white" : t.color }}
                    />
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Agenda body ──────────────────────────────────────────────────── */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 flex-1 w-full print:px-0 print:py-4">
        {eventData.sessions.length === 0 ? (
          <div className="text-center py-20">
            <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-slate-100 flex items-center justify-center">
              <Calendar className="h-7 w-7 text-slate-400" />
            </div>
            <p className="text-slate-700 font-semibold text-lg">Agenda Coming Soon</p>
            <p className="text-slate-500 text-sm mt-2 max-w-sm mx-auto leading-relaxed">
              The sessions haven&apos;t been added yet. Check back closer to the event
              for the full agenda.
            </p>
          </div>
        ) : (
          <div className="space-y-10 print:space-y-8">
            <p className="flex items-center gap-1.5 text-sm text-slate-400">
              <Clock className="h-3.5 w-3.5" />
              All times shown in event time
              {(() => {
                const lbl = tzLabel(new Date(eventData.startDate), eventData.timezone);
                return lbl ? ` (${lbl})` : "";
              })()}
            </p>
            {/* When "All Days" selected, show every date group */}
            {(selectedDate === null ? sessionsByDate : sessionsByDate.filter(([d]) => d === resolvedDate)).map(
              ([day, daySessions]) => {
                const dayFiltered =
                  selectedTrack === "all"
                    ? daySessions
                    : daySessions.filter((s) => s.track?.id === selectedTrack);

                if (dayFiltered.length === 0) return null;

                return (
                  <div key={day} className="print-day-group">
                    {/* Date heading */}
                    <div className="flex items-center gap-3 mb-5 print:mb-4 print-day-heading">
                      <div className="flex-1 h-px bg-slate-200 print:bg-slate-300" />
                      <div className="flex items-center gap-2 shrink-0">
                        <Calendar className="h-4 w-4 text-primary print:text-slate-600" />
                        <h2 className="text-base font-bold tracking-wide text-slate-700 uppercase print:text-slate-900">
                          {formatDateHeading(day)}
                        </h2>
                      </div>
                      <div className="flex-1 h-px bg-slate-200 print:bg-slate-300" />
                    </div>

                    {/* Sessions for this day. Sessions whose times OVERLAP
                        collapse into one "choose one" block so parallel halls
                        stop reading as a sequence; everything else renders
                        exactly as it always has. */}
                    <div className="space-y-4 print:space-y-2">
                      {buildAgendaRows(dayFiltered).map((row) =>
                        row.kind === "parallel" ? (
                          <ParallelBlock key={row.key} row={row} timezone={eventData.timezone} />
                        ) : (
                          <SessionRow key={row.key} session={row.session} timezone={eventData.timezone} />
                        )
                      )}
                    </div>
                  </div>
                );
              }
            )}

            {/* Show "no sessions for filter" if the visible list is empty */}
            {visibleSessions.length === 0 && selectedDate !== null && (
              <div className="text-center py-16">
                <p className="text-slate-400 text-sm">No sessions for this filter.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <div className="border-t border-slate-200 bg-white print:mt-8">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 flex items-center justify-between gap-4 flex-wrap">
          <span className="text-sm text-slate-500">{eventData.name}</span>
          <Link
            href={`/e/${slug}`}
            className="text-sm text-primary hover:underline flex items-center gap-1 print:hidden"
          >
            Register for this event
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
          <p className="text-xs text-slate-400 hidden print:block">
            Printed from {eventData.name} — Subject to change
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Parallel Block ────────────────────────────────────────────────────────

/**
 * Sessions running at the same time in different halls.
 *
 * Before this, three sessions all at 10:15–13:00 rendered as three stacked
 * cards with the time printed three times, which reads as a sequence. Someone
 * scanning the programme top to bottom had no way to learn they were a choice,
 * and the cost of getting that wrong is walking into the wrong hall.
 */
function ParallelBlock({
  row,
  timezone,
}: {
  row: Extract<AgendaRow<Session>, { kind: "parallel" }>;
  timezone: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-100/60 p-3 sm:p-4 print:border-slate-300 print:bg-white">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-1 pb-3">
        <span className="text-base font-bold text-slate-800 tabular-nums">
          {formatTimeInTz(new Date(row.start), timezone)} –{" "}
          {formatTimeInTz(new Date(row.end), timezone)}
        </span>
        <span className="text-slate-300">·</span>
        <span className="text-sm font-semibold text-primary">
          {row.columns.length} parallel sessions
        </span>
      </div>

      <div
        className={cn(
          "grid gap-3 print:grid-cols-1",
          row.columns.length === 2
            ? "md:grid-cols-2"
            : "md:grid-cols-2 lg:grid-cols-3",
        )}
      >
        {row.columns.map((column) => (
          <div key={column.room ?? "no-room"} className="flex flex-col gap-3">
            {column.room && (
              <div className="flex items-center gap-1.5 px-1">
                <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  {column.room}
                </span>
              </div>
            )}
            {column.sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                timezone={timezone}
                variant="column"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Session Row Component ─────────────────────────────────────────────────

/**
 * One row of the day: a break band or a full session card. Kept as the
 * dispatcher so a non-parallel day renders byte-for-byte as it did before the
 * parallel-block work.
 */
function SessionRow({ session, timezone }: { session: Session; timezone: string }) {
  if (isBreakSessionType(session.type)) {
    return <BreakBand session={session} timezone={timezone} />;
  }
  return <SessionCard session={session} timezone={timezone} variant="full" />;
}

// Break items — a slim, non-interactive band. They carry no speakers/topics
// (server-enforced), so none of the card machinery applies. Styled as an
// intentional divider (soft per-type accent chip + left border echoing the
// session cards' language) rather than the old dashed "placeholder" look,
// which read as an empty state next to the rich session cards.
function BreakBand({ session, timezone }: { session: Session; timezone: string }) {
  const duration = getDurationMin(session.startTime, session.endTime);
  const BreakIcon = BREAK_TYPE_ICONS[session.type ?? ""] ?? Clock;
  const accent =
    BREAK_TYPE_ACCENTS[session.type ?? ""] ?? {
      chip: "bg-slate-100",
      icon: "text-slate-500",
      border: "#94a3b8",
    };
  return (
      <div
        className="print-session-card rounded-xl border border-slate-200 bg-slate-50 px-5 py-3 print:rounded-none print:border-l-0 print:border-r-0 print:border-t-0 print:border-b print:border-slate-200"
        style={{ borderLeft: `4px solid ${accent.border}` }}
      >
        <div className="flex items-center gap-4">
          <div className="shrink-0 w-20 sm:w-28 text-right print:w-24">
            <p className="text-base font-semibold text-slate-700 tabular-nums">
              {formatTimeInTz(new Date(session.startTime), timezone)}
            </p>
            <p className="text-sm text-slate-400 tabular-nums">
              {formatTimeInTz(new Date(session.endTime), timezone)}
            </p>
          </div>
          <span
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-full shrink-0 print:hidden",
              accent.chip
            )}
          >
            <BreakIcon className={cn("h-[18px] w-[18px]", accent.icon)} />
          </span>
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <span className="text-base font-semibold text-slate-700 truncate">{session.name}</span>
            {session.location && (
              <span className="flex items-center gap-1 text-sm text-slate-400 shrink-0">
                <MapPin className="h-3.5 w-3.5" />
                {session.location}
              </span>
            )}
          </div>
          <span className="shrink-0 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-500 print:border-0">
            {duration} min
          </span>
        </div>
      </div>
  );
}

/**
 * A programme session.
 *
 * `variant="column"` is the cell inside a parallel block: the hall already sits
 * in the column header so the card drops it, and the time collapses to one
 * inline line because a ~300px column has no room for a right-aligned time rail.
 */
function SessionCard({
  session,
  timezone,
  variant,
}: {
  session: Session;
  timezone: string;
  variant: "full" | "column";
}) {
  const duration = getDurationMin(session.startTime, session.endTime);
  const color = session.track?.color || "#6B7280";
  const inColumn = variant === "column";
  const topicTimes = useMemo(
    () => computeTopicTimes(session.startTime, session.topics, timezone),
    [session.startTime, session.topics, timezone],
  );

  return (
    <div
      className="print-session-card bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden transition-shadow hover:shadow-md print:shadow-none print:rounded-none print:border-l-0 print:border-r-0 print:border-t-0 print:border-b print:border-slate-200"
      style={{ borderLeft: `4px solid ${color}` }}
    >
      {/* Was a <button> whose only job was toggling the description open.
          The description is always visible now, so the card has nothing to
          expand, and a card that invites a click and does nothing is worse
          than a plain one. */}
      <div className={cn("w-full text-left", inColumn ? "px-4 py-4" : "px-5 py-5")}>
        <div
          className={cn(
            "flex items-stretch gap-2",
            inColumn
              ? "flex-col"
              : "flex-col sm:flex-row sm:items-start sm:gap-5 print:flex-row",
          )}
        >
          {/* Time — one inline line inside a column and on phones, a
              right-aligned rail on sm+ in the full-width layout. */}
          {inColumn ? (
            <p className="text-sm font-bold text-slate-800 tabular-nums">
              {formatTimeInTz(new Date(session.startTime), timezone)} –{" "}
              {formatTimeInTz(new Date(session.endTime), timezone)}
              <span className="ml-2 font-normal text-slate-400">{duration} min</span>
            </p>
          ) : (
            <div className="shrink-0 sm:w-28 sm:pt-0.5 sm:text-right print:w-24 print:text-right flex flex-wrap items-baseline gap-x-2 sm:block print:block">
              <p className="text-base font-bold text-slate-800 tabular-nums whitespace-nowrap">
                {formatTimeInTz(new Date(session.startTime), timezone)}
                <span className="sm:hidden print:hidden font-normal text-slate-400">
                  {" "}– {formatTimeInTz(new Date(session.endTime), timezone)}
                </span>
              </p>
              <p className="hidden sm:block print:block text-sm text-slate-400 tabular-nums">
                {formatTimeInTz(new Date(session.endTime), timezone)}
              </p>
              <p className="text-sm text-slate-400 sm:mt-0.5 whitespace-nowrap">{duration} min</p>
            </div>
          )}

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-slate-900 text-lg leading-snug">
                  {session.name}
                  {/* Workshop/Symposium: program types beyond plain SESSION get
                      a small format chip so attendees can tell them apart. */}
                  {(session.type === "WORKSHOP" || session.type === "SYMPOSIUM") && (
                    <span className="ml-2 inline-block align-middle rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                      {formatSessionType(session.type)}
                    </span>
                  )}
                </h3>

                {/* Description sits directly under the title, always visible
                    (organizer, Aug 17 2026). It used to require expanding the
                    card, so on a printed-looking programme it read as absent. */}
                {session.description && (
                  <p className="mt-1.5 text-base text-slate-600 leading-relaxed whitespace-pre-line">
                    {session.description}
                  </p>
                )}

                {/* Meta row. Inside a parallel block the hall is the column
                    header, so repeating it on every card is noise. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                  {session.track && !inColumn && (
                    <span
                      className="flex items-center gap-1.5 text-sm font-medium"
                      style={{ color: session.track.color }}
                    >
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: session.track.color }}
                      />
                      {session.track.name}
                    </span>
                  )}
                  {session.location && (
                    <span className="flex items-center gap-1 text-sm text-slate-500">
                      <MapPin className="h-3.5 w-3.5" />
                      {session.location}
                    </span>
                  )}
                </div>

                {/* No speaker anywhere in this session (neither a session-level
                    role nor any topic) ⇒ a TBA chip, so the slot reads as
                    "a name is coming" instead of an unexplained blank. Break
                    items are excluded inside the helper. */}
                {sessionNeedsTba(session) && (
                  <div className="mt-3">
                    <span className="inline-flex items-center rounded-full border border-dashed border-slate-300 bg-slate-50 px-3 py-1 text-sm font-medium text-slate-500">
                      {TBA_LABEL}
                    </span>
                  </div>
                )}

                {/* Speakers (always visible) — name + role badge, no
                    affiliations (organizer decision, July 22). */}
                {session.speakers.length > 0 && (
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    {session.speakers.map(({ role, speaker }) => (
                      <div
                        key={speaker.id}
                        className="flex items-center gap-2 bg-slate-50 border border-slate-200/70 rounded-full pl-1.5 pr-3 py-1"
                      >
                        {speaker.photo ? (
                          <Image
                            src={speaker.photo}
                            alt={formatPersonName(speaker.title, speaker.firstName, speaker.lastName)}
                            width={24}
                            height={24}
                            className="h-6 w-6 rounded-full object-cover"
                            unoptimized
                          />
                        ) : (
                          <div className="h-6 w-6 rounded-full bg-primary/15 flex items-center justify-center">
                            <span className="text-[11px] font-bold text-primary">
                              {speaker.firstName[0]}
                            </span>
                          </div>
                        )}
                        <span className="text-sm text-slate-800 font-medium">
                          {formatPersonName(speaker.title, speaker.firstName, speaker.lastName)}
                        </span>
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-primary bg-primary/10 rounded-full px-2 py-0.5">
                          {formatSessionRole(role || "SPEAKER")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Topics — the session's run-sheet. Each row: start–end
                    (stacked from the session start, same rule as the
                    moderator run-sheet) + duration in a fixed time column,
                    title + presenters beside it. */}
                {session.topics.length > 0 && (
                  <ul className="mt-4 rounded-lg border border-slate-100 bg-slate-50/70 divide-y divide-slate-100 overflow-hidden">
                    {session.topics.map((topic) => {
                      const timeRange = topicTimes.get(topic.id);
                      return (
                        <li
                          key={topic.id}
                          className={cn(
                            "flex gap-1 px-4 py-3",
                            // Inside a parallel column the two-column run-sheet
                            // has nowhere to go: `sm:` reads the VIEWPORT, not
                            // the ~300px column, so on a wide screen it would
                            // still try to lay out side by side and clip the
                            // topic title. Columns always stack.
                            inColumn
                              ? "flex-col"
                              : "flex-col sm:flex-row sm:items-start sm:gap-4",
                          )}
                        >
                          <div className={cn("shrink-0", !inColumn && "sm:w-44 sm:pt-0.5")}>
                            {timeRange ? (
                              <>
                                <p className="print-topic-time text-sm font-semibold tabular-nums" style={{ color }}>
                                  <span className="whitespace-nowrap">{timeRange}</span>
                                  {topic.duration ? (
                                    <span
                                      className={cn(
                                        "font-normal text-slate-400 whitespace-nowrap",
                                        !inColumn && "sm:hidden",
                                      )}
                                    >
                                      {" "}· {topic.duration} min
                                    </span>
                                  ) : null}
                                </p>
                                {topic.duration && !inColumn ? (
                                  <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">
                                    {topic.duration} min
                                  </p>
                                ) : null}
                              </>
                            ) : (
                              <p className={cn("text-sm text-slate-300", inColumn ? "hidden" : "hidden sm:block")}>—</p>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-base font-medium text-slate-800 leading-snug">
                              {topic.title}
                            </p>
                            {topic.speakers.length > 0 ? (
                              <p className="text-sm text-slate-500 mt-1">
                                {topic.speakers
                                  .map(({ speaker }) =>
                                    formatPersonName(speaker.title, speaker.firstName, speaker.lastName),
                                  )
                                  .join(", ")}
                              </p>
                            ) : topicNeedsTba({
                                topicSpeakerCount: topic.speakers.length,
                                sessionShowsTba: sessionNeedsTba(session),
                              }) ? (
                              <p className="text-sm text-slate-400 mt-1 italic">{TBA_LABEL}</p>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
