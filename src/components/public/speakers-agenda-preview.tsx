"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { format } from "date-fns";
import {
  Users,
  Clock,
  MapPin,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { formatPersonName } from "@/lib/utils";

/**
 * Speakers + Agenda preview block for the public registration pages.
 *
 * Fetches `/api/public/events/[slug]/agenda` once and renders:
 *   1. A compact speakers grid (deduped, sorted, expandable)
 *   2. A collapsible agenda preview grouped by day
 *
 * Both sections silently render nothing when:
 *   - The agenda endpoint returns 404 (organizer hasn't set agendaPublished)
 *   - Sessions array is empty
 *   - No speakers are assigned to any session
 *
 * "No-data → zero footprint" is the design contract: an organizer who
 * hasn't built their agenda yet never sees empty placeholders on the
 * registration form. The component just disappears.
 */

interface Speaker {
  id: string;
  title: string | null;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  organization: string | null;
  photo: string | null;
}

interface Session {
  id: string;
  name: string;
  description: string | null;
  startTime: string;
  endTime: string;
  location: string | null;
  status: string;
  track: { id: string; name: string; color: string } | null;
  speakers: Array<{ speaker: Speaker }>;
}

interface AgendaData {
  id: string;
  name: string;
  slug: string;
  sessions: Session[];
}

// Cap the number of speakers visible before the user expands. Keeps the
// section compact on the registration page without hiding smaller events.
const SPEAKER_PREVIEW_LIMIT = 8;

interface SpeakersAndAgendaPreviewProps {
  slug: string;
}

export function SpeakersAndAgendaPreview({ slug }: SpeakersAndAgendaPreviewProps) {
  const [data, setData] = useState<AgendaData | null>(null);
  const [loading, setLoading] = useState(true);
  // Non-fatal: missing agenda is a normal state (organizer hasn't
  // published). We just render nothing — no error banner.
  const [unavailable, setUnavailable] = useState(false);
  const [speakersExpanded, setSpeakersExpanded] = useState(false);
  const [agendaExpanded, setAgendaExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/public/events/${slug}/agenda`);
        if (!res.ok) {
          // 404 = agenda not published yet, 429 = rate-limited. Either way,
          // just don't render the block — it's not an error we want to
          // surface on the registration form.
          if (!cancelled) setUnavailable(true);
          return;
        }
        const json = (await res.json()) as AgendaData;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setUnavailable(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Dedupe speakers across sessions and sort by first appearance.
  const uniqueSpeakers = useMemo<Speaker[]>(() => {
    if (!data) return [];
    const seen = new Set<string>();
    const out: Speaker[] = [];
    for (const session of data.sessions) {
      for (const entry of session.speakers) {
        const sp = entry.speaker;
        if (seen.has(sp.id)) continue;
        seen.add(sp.id);
        out.push(sp);
      }
    }
    return out;
  }, [data]);

  // Group sessions by date (YYYY-MM-DD from startTime, local-tz agnostic
  // since Zoom stores UTC and the public page renders in viewer tz).
  const sessionsByDay = useMemo(() => {
    if (!data) return [] as Array<{ date: Date; sessions: Session[] }>;
    const groups = new Map<string, Session[]>();
    for (const session of data.sessions) {
      const key = format(new Date(session.startTime), "yyyy-MM-dd");
      const list = groups.get(key) ?? [];
      list.push(session);
      groups.set(key, list);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, sessions]) => ({
        date: new Date(`${key}T00:00:00`),
        sessions: sessions.sort(
          (a, b) =>
            new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
        ),
      }));
  }, [data]);

  // Loading, unavailable, or genuinely empty agenda → render nothing.
  // We deliberately don't show a skeleton because the form itself is
  // visible immediately and the agenda block is secondary context.
  if (loading) return null;
  if (unavailable || !data) return null;
  if (uniqueSpeakers.length === 0 && sessionsByDay.length === 0) return null;

  const visibleSpeakers = speakersExpanded
    ? uniqueSpeakers
    : uniqueSpeakers.slice(0, SPEAKER_PREVIEW_LIMIT);
  const visibleDays = agendaExpanded ? sessionsByDay : sessionsByDay.slice(0, 1);
  const hasMoreDays = sessionsByDay.length > 1;
  const hiddenDayCount = sessionsByDay.length - 1;

  return (
    <div className="space-y-6 mb-8">
      {uniqueSpeakers.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base md:text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Featured Speakers
              <span className="text-xs font-normal text-slate-500">
                ({uniqueSpeakers.length})
              </span>
            </h2>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {visibleSpeakers.map((speaker) => (
              <div key={speaker.id} className="flex items-start gap-3">
                {speaker.photo ? (
                  <Image
                    src={speaker.photo}
                    alt={formatPersonName(speaker.title, speaker.firstName, speaker.lastName)}
                    width={48}
                    height={48}
                    className="rounded-full object-cover h-12 w-12 shrink-0"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-sky-500 flex items-center justify-center text-white text-sm font-medium shrink-0">
                    {speaker.firstName[0]}
                    {speaker.lastName[0]}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="font-medium text-sm text-slate-900 truncate">
                    {formatPersonName(speaker.title, speaker.firstName, speaker.lastName)}
                  </p>
                  {(speaker.jobTitle || speaker.organization) && (
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">
                      {[speaker.jobTitle, speaker.organization]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {uniqueSpeakers.length > SPEAKER_PREVIEW_LIMIT && (
            <button
              type="button"
              onClick={() => setSpeakersExpanded((v) => !v)}
              className="mt-4 text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
            >
              {speakersExpanded
                ? "Show fewer"
                : `Show all ${uniqueSpeakers.length} speakers`}
              <ChevronDown
                className={`h-4 w-4 transition-transform ${speakersExpanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </section>
      )}

      {sessionsByDay.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base md:text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              Agenda Preview
            </h2>
            <Link
              href={`/e/${slug}/agenda`}
              className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
            >
              Full schedule
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="space-y-5">
            {visibleDays.map((day) => (
              <div key={day.date.toISOString()}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  {format(day.date, "EEEE, MMMM d")}
                </h3>
                <ul className="space-y-2">
                  {day.sessions.map((session) => (
                    <li
                      key={session.id}
                      className="flex items-start gap-3 py-2 border-t border-slate-100 first:border-t-0"
                    >
                      <div className="shrink-0 text-xs text-slate-500 font-medium w-20">
                        {format(new Date(session.startTime), "h:mm a")}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-900">
                          {session.name}
                        </p>
                        {(session.location || session.track) && (
                          <div className="flex flex-wrap items-center gap-3 mt-0.5 text-xs text-slate-500">
                            {session.track && (
                              <span
                                className="inline-flex items-center gap-1"
                                style={{ color: session.track.color }}
                              >
                                <span
                                  className="h-2 w-2 rounded-full"
                                  style={{ backgroundColor: session.track.color }}
                                />
                                {session.track.name}
                              </span>
                            )}
                            {session.location && (
                              <span className="inline-flex items-center gap-1">
                                <MapPin className="h-3 w-3" />
                                {session.location}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {hasMoreDays && (
            <button
              type="button"
              onClick={() => setAgendaExpanded((v) => !v)}
              className="mt-4 text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
            >
              {agendaExpanded
                ? "Show first day only"
                : `Show ${hiddenDayCount} more day${hiddenDayCount === 1 ? "" : "s"}`}
              <ChevronDown
                className={`h-4 w-4 transition-transform ${agendaExpanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </section>
      )}
    </div>
  );
}
