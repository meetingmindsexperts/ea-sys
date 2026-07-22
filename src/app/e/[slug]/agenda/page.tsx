"use client";

import { useState, useEffect, useMemo } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { format } from "date-fns";
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
import { formatTimeInTz, localDateInTz, resolveTimezone, tzLabel } from "@/lib/event-time";
import { formatSessionRole, isBreakSessionType } from "@/lib/session-enums";

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
// slim muted band instead of a full session card.
const BREAK_TYPE_ICONS: Record<string, LucideIcon> = {
  REGISTRATION: ClipboardList,
  BREAK: Coffee,
  LUNCH: Utensils,
  NETWORKING: Users,
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

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="relative bg-slate-900 print:bg-white print:border-b print:border-slate-200">
        <div className="absolute inset-0 opacity-5 bg-dot-pattern print:hidden" />
        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 py-8 print:py-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-white print:text-slate-900 mb-1">
                {eventData.name}
              </h1>
              <p className="text-primary/80 text-sm font-medium print:text-slate-500">
                Agenda
              </p>
              <div className="flex items-center gap-1.5 mt-3 text-sm text-white/60 print:text-slate-500">
                <Calendar className="h-3.5 w-3.5" />
                <span>
                  {format(new Date(eventData.startDate), "MMMM d")} –{" "}
                  {format(new Date(eventData.endDate), "MMMM d, yyyy")}
                </span>
              </div>
            </div>

            {/* Print button */}
            <button
              type="button"
              onClick={() => window.print()}
              className="shrink-0 flex items-center gap-2 bg-white/10 hover:bg-white/20 border border-white/20 text-white text-sm font-medium px-4 py-2 rounded-xl transition-colors print:hidden"
            >
              <Printer className="h-4 w-4" />
              Print / Save PDF
            </button>
          </div>
        </div>
      </div>

      {/* ── Filters (hidden when printing) ───────────────────────────────── */}
      {(allDates.length > 1 || (eventData.tracks.length > 0)) && (
        <div className="bg-white border-b border-slate-100 print:hidden">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center gap-4">
            {/* Day tabs */}
            {allDates.length > 1 && (
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-xs font-semibold tracking-widest uppercase text-slate-400 mr-1">
                  Day
                </span>
                {allDates.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setSelectedDate(d)}
                    className={cn(
                      "px-3 py-1 rounded-lg text-sm font-medium transition-colors",
                      resolvedDate === d
                        ? "bg-primary text-white"
                        : "text-slate-600 hover:bg-slate-100"
                    )}
                  >
                    Day {i + 1}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setSelectedDate(null)}
                  className={cn(
                    "px-3 py-1 rounded-lg text-sm font-medium transition-colors",
                    selectedDate === null
                      ? "bg-primary text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  )}
                >
                  All Days
                </button>
              </div>
            )}

            {/* Track filter */}
            {eventData.tracks.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-semibold tracking-widest uppercase text-slate-400">
                  Track
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedTrack("all")}
                  className={cn(
                    "px-3 py-1 rounded-lg text-sm font-medium transition-colors",
                    selectedTrack === "all"
                      ? "bg-slate-800 text-white"
                      : "text-slate-600 hover:bg-slate-100"
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
                        : "text-slate-600 border-transparent hover:bg-slate-100"
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
            )}
          </div>
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
                    <div className="flex items-center gap-3 mb-5 print:mb-4">
                      <div className="flex-1 h-px bg-slate-200 print:bg-slate-300" />
                      <div className="flex items-center gap-2 shrink-0">
                        <Calendar className="h-4 w-4 text-primary print:text-slate-600" />
                        <h2 className="text-base font-bold tracking-wide text-slate-700 uppercase print:text-slate-900">
                          {formatDateHeading(day)}
                        </h2>
                      </div>
                      <div className="flex-1 h-px bg-slate-200 print:bg-slate-300" />
                    </div>

                    {/* Sessions for this day */}
                    <div className="space-y-4 print:space-y-2">
                      {dayFiltered.map((session) => (
                        <SessionRow key={session.id} session={session} timezone={eventData.timezone} />
                      ))}
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

// ── Session Row Component ─────────────────────────────────────────────────

function SessionRow({ session, timezone }: { session: Session; timezone: string }) {
  const [expanded, setExpanded] = useState(false);
  const duration = getDurationMin(session.startTime, session.endTime);
  const color = session.track?.color || "#6B7280";
  const topicTimes = useMemo(
    () => computeTopicTimes(session.startTime, session.topics, timezone),
    [session.startTime, session.topics, timezone],
  );

  // Break items — a slim, muted, non-interactive band. They carry no
  // speakers/topics (server-enforced), so none of the card machinery applies.
  if (isBreakSessionType(session.type)) {
    const BreakIcon = BREAK_TYPE_ICONS[session.type ?? ""] ?? Clock;
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-3.5 print:rounded-none print:border-l-0 print:border-r-0 print:border-t-0 print:border-b print:border-slate-200">
        <div className="flex items-center gap-4">
          <div className="shrink-0 w-20 sm:w-28 text-right print:w-24">
            <p className="text-base font-semibold text-slate-600 tabular-nums">
              {formatTimeInTz(new Date(session.startTime), timezone)}
            </p>
            <p className="text-sm text-slate-400 tabular-nums">
              {formatTimeInTz(new Date(session.endTime), timezone)}
            </p>
          </div>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <BreakIcon className="h-5 w-5 text-slate-400 shrink-0" />
            <span className="text-base font-medium text-slate-600 truncate">{session.name}</span>
            {session.location && (
              <span className="flex items-center gap-1 text-sm text-slate-400 shrink-0">
                <MapPin className="h-3.5 w-3.5" />
                {session.location}
              </span>
            )}
          </div>
          <span className="text-sm text-slate-400 shrink-0">{duration} min</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden transition-shadow hover:shadow-md print:shadow-none print:rounded-none print:border-l-0 print:border-r-0 print:border-t-0 print:border-b print:border-slate-200"
      style={{ borderLeft: `4px solid ${color}` }}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-5 py-5 print:cursor-default print:pointer-events-none"
      >
        <div className="flex flex-col sm:flex-row items-stretch sm:items-start gap-2 sm:gap-5 print:flex-row">
          {/* Time — inline line on phones, right-aligned column on sm+ */}
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

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-slate-900 text-lg leading-snug">
                  {session.name}
                </h3>

                {/* Meta row */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                  {session.track && (
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
                        <li key={topic.id} className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 px-4 py-3">
                          <div className="shrink-0 sm:w-44 sm:pt-0.5">
                            {timeRange ? (
                              <>
                                <p className="text-sm font-semibold tabular-nums" style={{ color }}>
                                  <span className="whitespace-nowrap">{timeRange}</span>
                                  {topic.duration ? (
                                    <span className="sm:hidden font-normal text-slate-400 whitespace-nowrap">
                                      {" "}· {topic.duration} min
                                    </span>
                                  ) : null}
                                </p>
                                {topic.duration ? (
                                  <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">
                                    {topic.duration} min
                                  </p>
                                ) : null}
                              </>
                            ) : (
                              <p className="hidden sm:block text-sm text-slate-300">—</p>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-base font-medium text-slate-800 leading-snug">
                              {topic.title}
                            </p>
                            {topic.speakers.length > 0 && (
                              <p className="text-sm text-slate-500 mt-1">
                                {topic.speakers
                                  .map(({ speaker }) =>
                                    formatPersonName(speaker.title, speaker.firstName, speaker.lastName),
                                  )
                                  .join(", ")}
                              </p>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* Expand toggle */}
              {session.description && (
                <ChevronRight
                  className={cn(
                    "h-5 w-5 text-slate-400 shrink-0 mt-0.5 transition-transform print:hidden",
                    expanded && "rotate-90"
                  )}
                />
              )}
            </div>

            {/* Expandable description */}
            {session.description && expanded && (
              <p className="mt-3 text-base text-slate-600 leading-relaxed border-t border-slate-100 pt-3">
                {session.description}
              </p>
            )}

            {/* Print: always show description */}
            {session.description && (
              <p className="mt-2 text-sm text-slate-500 leading-relaxed hidden print:block">
                {session.description}
              </p>
            )}
          </div>
        </div>
      </button>
    </div>
  );
}
