"use client";

/**
 * The webinar's reports (moved from the Webinar Console's Analytics tab to the event's Analytics page on
 * Nov 23, 2026, owner: "move all analytics to one place"): attendance on our own page, how people
 * watched, Zoom's attendance, poll and Q&A reports. WebinarAnalyticsSection is what the Analytics page
 * renders for a webinar.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BarChart3, Download, FileText, Loader2, MessageSquare, RotateCw, TrendingUp, Users, Video } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useCan } from "@/hooks/use-can";
import {
  useSyncWebinarAttendance,
  useSyncWebinarEngagement,
  useWebinar,
  useWebinarAttendance,
  useWebinarEngagement,
  useWebinarPresenceSummary,
  type WebinarAttendeeRow,
  type WebinarPollRow,
  type WebinarQaRow,
} from "@/hooks/use-api";
import { DEFAULT_EVENT_TIMEZONE } from "@/lib/event-time";
import { webinarStatusFromTimes } from "@/lib/webinar/console-rules";
import { WatchAnalyticsCard } from "@/components/webinar/watch-analytics-card";
import { downloadPostEventReport } from "@/lib/webinar/post-event-report-download";
import {
  afterSessionTitle,
  CardEmpty,
  CardLoading,
  ConsoleTitle,
  EventTzContext,
  fmtTz,
  formatDuration,
  KpiTile,
  useEventTz,
} from "@/components/webinar/console-ui";

/**
 * The webinar section of the event's Analytics page: what was the Webinar Console's Analytics tab, with
 * the same rules for which report applies. Attendance on our page and how people watched for a
 * custom-stream or partner webinar (our page is the audience there); Zoom's attendance, polls and Q&A
 * for a webinar run on Zoom; a partner's webinar has no Zoom reports.
 */
export function WebinarAnalyticsSection({ eventId, heading = true }: { eventId: string; heading?: boolean }) {
  const { data, isLoading, error } = useWebinar(eventId);
  // The console's Analytics button links to #webinar, but the browser looks for the anchor before this
  // section exists (it renders once the page's and this section's data arrive): scroll to it then
  // (review of f0597c424).
  const loaded = Boolean(data);
  useEffect(() => {
    if (!loaded || typeof window === "undefined" || window.location.hash !== "#webinar") return;
    document.getElementById("webinar")?.scrollIntoView({ block: "start" });
  }, [loaded]);
  const status = useMemo(
    () =>
      webinarStatusFromTimes(data?.anchorSession?.startTime, data?.anchorSession?.endTime, data?.anchorSession?.status),
    [data?.anchorSession?.startTime, data?.anchorSession?.endTime, data?.anchorSession?.status],
  );
  if (isLoading) return <CardLoading />;
  if (error || !data) {
    return (
      <Card>
        <CardContent className="py-5 text-sm text-red-600">Could not load the webinar reports.</CardContent>
      </Card>
    );
  }
  const partner = data.videoSource === "external";
  const ourPage = partner || data.webinar?.viewingMode === "hls";
  const hasZoom = Boolean(data.zoomMeeting);
  const sessionEnded = status === "ended";
  return (
    <EventTzContext.Provider value={data.event?.timezone || DEFAULT_EVENT_TIMEZONE}>
      <section id="webinar" className="scroll-mt-24 space-y-6">
        {heading ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Webinar</h2>
              <p className="text-sm text-muted-foreground">
                Who attended and how they watched, with the polls and questions.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" asChild>
                <Link href={`/events/${eventId}/analytics/report`}>
                  <FileText className="mr-2 h-4 w-4" />
                  Post-event report
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/events/${eventId}/webinar`}>
                  <Video className="mr-2 h-4 w-4" />
                  Webinar Console
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          // In the console's Recording tab, for someone who cannot open the Analytics page (and so not
          // the report page under it): the PDF of the same report.
          // Without survey comments: this button shows no warning about typed text (review of cdec0c859).
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadPostEventReport(eventId, "pdf", { includeComments: false }).catch((err) =>
                  toast.error(err instanceof Error ? err.message : "Could not download the report."),
                )
              }
            >
              <FileText className="mr-2 h-4 w-4" />
              Download post-event report (PDF)
            </Button>
          </div>
        )}
        {ourPage ? (
          <>
            <PageAttendanceCard eventId={eventId} partner={partner} />
            <WatchAnalyticsCard eventId={eventId} timezone={data.event?.timezone || DEFAULT_EVENT_TIMEZONE} />
          </>
        ) : null}
        {partner ? (
          <PartnerAnalyticsNote />
        ) : (
          <>
            <AttendanceCard
              eventId={eventId}
              sessionEnded={sessionEnded}
              hasZoom={hasZoom}
              customStream={data.webinar?.viewingMode === "hls"}
            />
            {/* Polls + Q&A are peer reports: side by side on wide screens. */}
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <PollsCard eventId={eventId} sessionEnded={sessionEnded} hasZoom={hasZoom} />
              <QaCard eventId={eventId} sessionEnded={sessionEnded} hasZoom={hasZoom} />
            </div>
          </>
        )}
      </section>
    </EventTzContext.Provider>
  );
}

/** The webinar reports of a partner's webinar: Zoom's reports have nothing to read. */
function PartnerAnalyticsNote() {
  return (
    <Card>
      <CardContent className="py-5 text-sm text-muted-foreground">
        Zoom&apos;s attendance, poll and Q&amp;A reports do not apply here: this webinar is streamed by a partner, not
        run on Zoom. Attendance is the page report above; the questions and polls attendees answered are on the Webinar
        Console&apos;s Q&amp;A and Polls tabs.
      </CardContent>
    </Card>
  );
}

/**
 * Attendance from our own webinar page (Nov 16, 2026; presence-report.ts): who
 * opened it, who reached the live view, and the minutes they watched while the
 * room was open. The CSV carries names and emails, so its button needs the
 * attendance-export permission, like Zoom's report.
 */
function PageAttendanceCard({ eventId, partner }: { eventId: string; partner: boolean }) {
  const summary = useWebinarPresenceSummary(eventId);
  const canExport = useCan("webinar.attendance.export", eventId) === "allowed";
  const s = summary.data;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <ConsoleTitle icon={Users} tone="emerald">
              Attendance on our page
            </ConsoleTitle>
            <CardDescription>
              {partner
                ? "Who opened the webinar page and how long they watched while the room was open. For a partner's stream this is the attendance."
                : "Who opened the webinar page and how long they watched the custom stream while the room was open. Zoom's report below sees only the speakers in this mode."}
            </CardDescription>
          </div>
          {canExport && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(`/api/events/${eventId}/webinar/presence?export=csv`, "_blank")}
            >
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {summary.isLoading ? <CardLoading /> : null}
        {summary.isError ? (
          <p className="text-sm text-red-600">
            {summary.error instanceof Error ? summary.error.message : "Could not load the page attendance."}
          </p>
        ) : null}
        {s ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiTile label="Opened the page" value={String(s.opened)} />
            <KpiTile label="Reached the live view" value={String(s.joined)} />
            <KpiTile label="Average watched" value={formatDuration(s.avgWatchedSeconds)} />
            <KpiTile label="Total watched" value={formatDuration(s.totalWatchedSeconds)} />
          </div>
        ) : null}
        <p className="mt-3 text-xs text-muted-foreground">
          Minutes are counted while the page is open and in view, so most time spent listening from a hidden tab
          or a minimised window is not counted. The page record is kept for 90 days, then archived.
        </p>
      </CardContent>
    </Card>
  );
}

function AttendanceCard({
  eventId,
  sessionEnded,
  hasZoom,
  customStream = false,
}: {
  eventId: string;
  sessionEnded: boolean;
  hasZoom: boolean;
  /**
   * Custom stream mode: attendees watch on our page, so Zoom sees only the speakers and hosts. The
   * card is then "Zoom participants", without the registered and attendance-rate figures, which read
   * as a low turnout beside the page attendance card (UX review, Nov 16, 2026).
   */
  customStream?: boolean;
}) {
  const eventTz = useEventTz();
  const { data, isLoading, isFetching } = useWebinarAttendance(eventId);
  const sync = useSyncWebinarAttendance(eventId);

  const handleSync = async () => {
    try {
      const result = await sync.mutateAsync();
      if (result.status === "synced") {
        toast.success(
          `Synced: fetched ${result.fetched ?? 0} participants, matched ${result.matched ?? 0} to registrations`,
        );
      } else if (result.status === "pending") {
        toast.warning(result.reason || "Attendance report not ready yet");
      } else {
        toast.error(result.reason || "Failed to sync attendance");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to sync attendance");
    }
  };

  const handleExportCsv = () => {
    window.open(`/api/events/${eventId}/webinar/attendance?export=csv`, "_blank");
  };

  const kpis = data?.kpis;
  const rows = data?.rows ?? [];
  const canSync = sessionEnded && hasZoom;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <ConsoleTitle icon={Users} tone="sky">
              {customStream ? "Zoom participants (speakers and hosts)" : "Attendance"}
              {isFetching && !isLoading && (
                <ReloadingSpinner className="ml-1 inline-block" />
              )}
            </ConsoleTitle>
            <CardDescription>
              {customStream
                ? "Attendees watched on our page, so Zoom's report lists only the people in Zoom: speakers and hosts. Audience attendance is in Attendance on our page. "
                : null}
              Pulled from Zoom&apos;s participant report. Polled automatically once the session has been over for 30 min.
              {kpis?.lastSyncedAt ? (
                <> Last synced {fmtTz(kpis.lastSyncedAt, eventTz)}.</>
              ) : null}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {rows.length > 0 ? (
              <Button variant="outline" size="sm" onClick={handleExportCsv}>
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={sync.isPending || !canSync}
              title={afterSessionTitle(hasZoom, sessionEnded)}
            >
              {sync.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RotateCw className="h-4 w-4 mr-2" />
              )}
              Sync now
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <CardLoading />
        ) : null}
        {!isLoading && !hasZoom ? (
          <CardEmpty message="No Zoom webinar attached yet." />
        ) : null}
        {!isLoading && hasZoom && !sessionEnded && rows.length === 0 ? (
          <CardEmpty message="Attendance will appear here after the session ends and Zoom finalizes the participant report (typically ~30 min)." />
        ) : null}
        {!isLoading && hasZoom && !(!sessionEnded && rows.length === 0) ? (
          <div className="space-y-6">
            {/* KPI grid */}
            {customStream ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <KpiTile label="In Zoom" value={kpis?.attended ?? 0} />
                <KpiTile label="Avg. time in Zoom" value={formatDuration(kpis?.avgWatchSeconds ?? 0)} icon={TrendingUp} />
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <KpiTile label="Registered" value={kpis?.registered ?? 0} />
                <KpiTile label="Attended" value={kpis?.attended ?? 0} />
                <KpiTile
                  label="Attendance rate"
                  value={`${kpis?.attendanceRate ?? 0}%`}
                  accent={
                    (kpis?.attendanceRate ?? 0) >= 50 ? "text-green-600" : "text-amber-600"
                  }
                />
                <KpiTile
                  label="Avg. watch time"
                  value={formatDuration(kpis?.avgWatchSeconds ?? 0)}
                  icon={TrendingUp}
                />
              </div>
            )}

            {/* Attendees table */}
            {rows.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No participants yet. Click Sync to fetch from Zoom.
              </div>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Name</th>
                      <th className="px-3 py-2 text-left font-medium">Email</th>
                      <th className="px-3 py-2 text-left font-medium">Joined</th>
                      <th className="px-3 py-2 text-left font-medium">Watched</th>
                      <th className="px-3 py-2 text-left font-medium">Reg #</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((row) => (
                      <AttendeeRowView key={row.id} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AttendeeRowView({ row }: { row: WebinarAttendeeRow }) {
  const eventTz = useEventTz();
  return (
    <tr className="hover:bg-muted/30">
      <td className="px-3 py-2 font-medium">{row.name}</td>
      <td className="px-3 py-2 text-muted-foreground">{row.email ?? "–"}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {fmtTz(row.joinTime, eventTz, { short: true })}
      </td>
      <td className="px-3 py-2">{formatDuration(row.durationSeconds)}</td>
      <td className="px-3 py-2 text-xs">
        {row.registrationSerialId ? (
          <span className="font-mono">
            {String(row.registrationSerialId).padStart(3, "0")}
          </span>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </td>
    </tr>
  );
}

function PollsCard({
  eventId,
  sessionEnded,
  hasZoom,
}: {
  eventId: string;
  sessionEnded: boolean;
  hasZoom: boolean;
}) {
  const eventTz = useEventTz();
  const { data, isLoading } = useWebinarEngagement(eventId);
  const sync = useSyncWebinarEngagement(eventId);

  const handleSync = async () => {
    try {
      const result = await sync.mutateAsync();
      if (result.status === "synced") {
        const polls = result.pollsPersisted ?? 0;
        const responses = result.pollResponsesPersisted ?? 0;
        const qa = result.questionsPersisted ?? 0;
        toast.success(
          `Engagement synced: ${polls} poll(s), ${responses} response(s), ${qa} Q&A`,
        );
      } else if (result.status === "pending") {
        toast.warning(result.reason || "Report not ready yet");
      } else {
        toast.error(result.reason || "Failed to sync engagement");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to sync engagement");
    }
  };

  const polls: WebinarPollRow[] = data?.polls ?? [];
  const canSync = sessionEnded && hasZoom;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <ConsoleTitle icon={BarChart3} tone="amber">
              Polls
            </ConsoleTitle>
            <CardDescription>
              Results from polls run during the webinar. Pulled from Zoom alongside
              attendance (~30 min after session ends).
              {data?.lastSyncedAt ? (
                <> Last synced {fmtTz(data.lastSyncedAt, eventTz)}.</>
              ) : null}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={sync.isPending || !canSync}
            title={afterSessionTitle(hasZoom, sessionEnded)}
          >
            {sync.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4 mr-2" />
            )}
            Sync now
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!hasZoom ? (
          <CardEmpty message="No Zoom webinar attached yet." />
        ) : null}
        {hasZoom && isLoading ? (
          <CardLoading />
        ) : null}
        {hasZoom && !isLoading && polls.length === 0 ? (
          <CardEmpty
            message={
              sessionEnded
                ? "No poll results yet. Click Sync to fetch from Zoom (or wait for the cron)."
                : "Poll results will appear here after the session ends."
            }
          />
        ) : null}
        {hasZoom && !isLoading && polls.length > 0 ? (
          <div className="space-y-6">
            {polls.map((poll) => (
              <PollView key={poll.id} poll={poll} />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PollView({ poll }: { poll: WebinarPollRow }) {
  // Build a distribution: question → { answer → count }
  const distribution: Record<string, Record<string, number>> = {};
  for (const q of poll.questions) {
    distribution[q] = {};
  }
  for (const response of poll.responses) {
    for (const [question, answer] of Object.entries(response.answers)) {
      if (!distribution[question]) distribution[question] = {};
      const key = String(answer);
      distribution[question][key] = (distribution[question][key] ?? 0) + 1;
    }
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="bg-muted/40 px-4 py-2 flex items-center justify-between">
        <h4 className="font-semibold text-sm">{poll.title}</h4>
        <span className="text-xs text-muted-foreground">
          {poll.responses.length} response{poll.responses.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="p-4 space-y-4">
        {poll.questions.map((q) => {
          const answers = distribution[q] ?? {};
          const entries = Object.entries(answers).sort((a, b) => b[1] - a[1]);
          const maxCount = entries[0]?.[1] ?? 1;
          return (
            <div key={q}>
              <p className="text-sm font-medium mb-2">{q}</p>
              {entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">No responses</p>
              ) : (
                <div className="space-y-1.5">
                  {entries.map(([answer, count]) => (
                    <div key={answer} className="flex items-center gap-2">
                      <div className="flex-1">
                        <div className="flex items-center justify-between text-xs mb-0.5">
                          <span className="text-foreground">{answer}</span>
                          <span className="text-muted-foreground">{count}</span>
                        </div>
                        <div className="w-full h-2 bg-muted rounded overflow-hidden">
                          <div
                            className="h-full bg-primary"
                            style={{ width: `${(count / maxCount) * 100}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QaCard({
  eventId,
  sessionEnded,
  hasZoom,
}: {
  eventId: string;
  sessionEnded: boolean;
  hasZoom: boolean;
}) {
  const eventTz = useEventTz();
  const { data, isLoading } = useWebinarEngagement(eventId);
  const [search, setSearch] = useState("");

  const questions: WebinarQaRow[] = data?.questions ?? [];
  const filtered = search
    ? questions.filter(
        (q) =>
          q.question.toLowerCase().includes(search.toLowerCase()) ||
          q.askerName.toLowerCase().includes(search.toLowerCase()) ||
          (q.answer?.toLowerCase().includes(search.toLowerCase()) ?? false),
      )
    : questions;

  return (
    <Card>
      <CardHeader>
        <ConsoleTitle icon={MessageSquare} tone="emerald">
          Q&amp;A
        </ConsoleTitle>
        <CardDescription>
          Questions asked during the webinar and their answers. Pulled from Zoom alongside polls.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hasZoom ? (
          <CardEmpty message="No Zoom webinar attached yet." />
        ) : null}
        {hasZoom && isLoading ? (
          <CardLoading />
        ) : null}
        {hasZoom && !isLoading && questions.length === 0 ? (
          <CardEmpty
            message={
              sessionEnded
                ? "No Q&A yet. Sync polls/Q&A from the Polls card to fetch the report."
                : "Q&A will appear here after the session ends."
            }
          />
        ) : null}
        {hasZoom && !isLoading && questions.length > 0 ? (
          <div className="space-y-3">
            <Input
              placeholder="Search questions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No questions match &quot;{search}&quot;
              </p>
            ) : (
              <div className="space-y-3">
                {filtered.map((q) => (
                  <div key={q.id} className="border rounded-lg p-3">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="text-sm font-medium">{q.askerName}</div>
                      <div className="text-xs text-muted-foreground shrink-0">
                        {fmtTz(q.askedAt, eventTz, { short: true })}
                      </div>
                    </div>
                    <p className="text-sm">{q.question}</p>
                    {q.answer ? (
                      <div className="mt-2 pt-2 border-t text-sm text-muted-foreground">
                        <span className="text-xs font-medium uppercase tracking-wide text-green-700 mr-1">
                          Answer:
                        </span>
                        {q.answer}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-1 italic">
                        Unanswered
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
