"use client";

/**
 * A webinar's post-event report on screen (Nov 23, 2026; src/lib/webinar/post-event-report.ts), with
 * the same report one click away as a PDF, a Word copy to edit before forwarding, or a CSV of the
 * numbers (Nov 25, 2026). Counts, shares and survey answers only, so it can be
 * forwarded to a client or a sponsor.
 */
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePostEventReport } from "@/hooks/use-api";
import { downloadPostEventReport, type PostEventReportFormat } from "@/lib/webinar/post-event-report-download";
import { knownTimezone, DEFAULT_EVENT_TIMEZONE } from "@/lib/event-time";
import {
  percentOf,
  reportDuration,
  type PostEventReport,
  type ReportBreakdown,
  type ReportSurveyQuestion,
} from "@/lib/webinar/post-event-report";

export default function PostEventReportPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const query = usePostEventReport(eventId);

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="py-24 text-center text-sm text-muted-foreground">
        {query.error instanceof Error ? query.error.message : "Could not load the post-event report."}
      </div>
    );
  }
  return <ReportView eventId={eventId} report={query.data} />;
}

const DOWNLOADS: { format: PostEventReportFormat; label: string; title: string }[] = [
  { format: "pdf", label: "PDF", title: "The report to forward as it is" },
  { format: "docx", label: "Word", title: "An editable copy: change the wording before you forward it" },
  { format: "csv", label: "CSV", title: "The numbers, for a spreadsheet" },
];

function ReportView({ eventId, report: r }: { eventId: string; report: PostEventReport }) {
  // Comments are the respondents' own words: in a download only when ticked here, beside the warning.
  const [withComments, setWithComments] = useState(false);
  const [downloading, setDownloading] = useState<PostEventReportFormat | null>(null);
  const download = async (format: PostEventReportFormat) => {
    setDownloading(format);
    try {
      await downloadPostEventReport(eventId, format, { includeComments: withComments });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not download the report.");
    } finally {
      setDownloading(null);
    }
  };
  const tz = knownTimezone(r.event.timezone) ?? DEFAULT_EVENT_TIMEZONE;
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href={`/events/${eventId}/analytics#webinar`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Analytics
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Post-event report</h1>
          <p className="text-sm text-muted-foreground">
            {r.event.name}
            {r.event.startTime ? ` · ${when.format(new Date(r.event.startTime))} (${tz})` : ""}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Download</span>
            {DOWNLOADS.map((d) => (
              <Button key={d.format} variant={d.format === "pdf" ? "default" : "outline"} size="sm" title={d.title} onClick={() => download(d.format)} disabled={downloading !== null}>
                {downloading === d.format ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
                {d.label}
              </Button>
            ))}
          </div>
          {r.surveys && r.surveys.length > 0 ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={withComments} onChange={(e) => setWithComments(e.target.checked)} />
              Include survey comments in the download
            </label>
          ) : null}
        </div>
      </div>

      {r.event.status !== "ended" ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          The webinar has not ended yet: these figures are so far.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Made to be forwarded: no attendee&apos;s name or email, and questions and comments without who wrote them, with
        email addresses and phone numbers removed. A comment is still the respondent&apos;s own words, so a download leaves
        comments out unless you tick the box, and you should read them before you send it on. The Word copy can be
        edited before you forward it; the CSV holds the same numbers for a spreadsheet.
      </p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="Registered" value={String(r.registrations.registered)} />
        <Tile label="Attended" value={`${r.attendance.attended} (${r.attendance.attendanceRate}%)`} />
        <Tile label="Average watched" value={reportDuration(r.attendance.avgWatchSeconds)} />
        <Tile label="Most watching at once" value={String(r.attendance.peak)} />
        <Tile label="Questions asked" value={String(r.questions.asked)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Registrations">
          <p className="text-sm text-muted-foreground">
            {r.registrations.registered} registered: {r.registrations.confirmed} confirmed, {r.registrations.pending} pending.{" "}
            {r.registrations.cancelled} cancelled (not counted).
          </p>
          <Bars rows={r.registrations.byType} total={r.registrations.registered} />
        </Section>
        <Section title="Attendance">
          <p className="text-sm text-muted-foreground">
            {r.attendance.attended} attended, {r.attendance.attendanceRate}% of the {r.registrations.confirmed} confirmed
            registrations.{" "}
            {r.attendance.archived
              ? null
              : `Average watched ${reportDuration(r.attendance.avgWatchSeconds)}, ${reportDuration(r.attendance.totalWatchSeconds)} in all. `}
            {r.attendance.source === "page"
              ? "Counted on the webinar page: people who reached the live view, and the minutes they watched while it was open."
              : "From Zoom's participant report."}
          </p>
          {r.attendance.archived ? (
            <p className="text-xs text-muted-foreground">
              This webinar is more than 90 days old: the minute-by-minute record has been archived, so the time watched,
              the peak and the devices are not shown.
            </p>
          ) : null}
          {r.attendance.devices.length ? (
            <>
              <h3 className="pt-2 text-sm font-medium">Watched on</h3>
              <Bars rows={r.attendance.devices} total={r.attendance.attended} />
            </>
          ) : null}
        </Section>
      </div>

      <Section title={`Questions (${r.questions.asked} asked, ${r.questions.answered} answered)`}>
        {r.questions.items.length === 0 ? <p className="text-sm text-muted-foreground">No questions were asked.</p> : null}
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">
          {r.questions.items.map((q, i) => (
            <li key={`${i}-${q.question.slice(0, 20)}`}>
              <span>{q.question}</span>
              {q.answered ? <span className="ml-2 text-xs text-emerald-700">answered</span> : null}
              {q.votes > 0 ? <span className="ml-2 text-xs text-muted-foreground">{q.votes} vote{q.votes === 1 ? "" : "s"}</span> : null}
            </li>
          ))}
        </ol>
        {r.questions.items.length < r.questions.asked ? (
          <p className="text-xs text-muted-foreground">The first {r.questions.items.length} are listed.</p>
        ) : null}
      </Section>

      {r.surveys === null ? (
        <p className="text-sm text-muted-foreground">Survey results are left out: your role cannot read survey answers.</p>
      ) : (
        <Section title="Survey results">
          {r.surveys.length === 0 ? <p className="text-sm text-muted-foreground">No survey answers yet.</p> : null}
          {r.surveys.map((s, si) => (
            <div key={`${si}-${s.name}`} className="space-y-4">
              <h3 className="text-sm font-semibold">
                {s.name}: {s.responses} response{s.responses === 1 ? "" : "s"}
              </h3>
              {s.questions.map((q, i) => (
                <SurveyQuestion key={`${s.name}-${i}`} q={q} />
              ))}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function SurveyQuestion({ q }: { q: ReportSurveyQuestion }) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{q.label}</p>
      <SurveyAnswers q={q} />
    </div>
  );
}

function SurveyAnswers({ q }: { q: ReportSurveyQuestion }) {
  if (q.type === "rating") {
    const rows = [5, 4, 3, 2, 1].map((stars) => ({ label: `${stars} star${stars === 1 ? "" : "s"}`, count: q.distribution[stars - 1] ?? 0 }));
    return (
      <>
        <p className="text-xs text-muted-foreground">
          Average {q.mean === null ? "no answers" : `${q.mean.toFixed(1)} out of 5`} ({q.count} answer{q.count === 1 ? "" : "s"})
        </p>
        <Bars rows={rows} total={q.count} />
      </>
    );
  }
  if (q.type === "choice") return <Bars rows={q.options} total={q.count} />;
  if (q.comments.length === 0) return <p className="text-xs text-muted-foreground">No comments.</p>;
  return (
    <ul className="space-y-1 border-l pl-3 text-sm text-muted-foreground">
      {q.comments.map((c, i) => (
        <li key={i}>&ldquo;{c}&rdquo;</li>
      ))}
      {q.comments.length < q.count ? (
        <li className="text-xs">
          The newest {q.comments.length} of {q.count} comments.
        </li>
      ) : null}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold uppercase tracking-wide text-slate-700">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Bars({ rows, total }: { rows: readonly ReportBreakdown[]; total: number }) {
  return (
    <ul className="space-y-1.5">
      {rows.map((row, i) => {
        const share = percentOf(row.count, total);
        return (
          <li key={`${i}-${row.label}`} className="text-sm">
            <div className="flex min-w-0 items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="tabular-nums text-muted-foreground">
                <span className="font-medium text-foreground">{row.count}</span> · {share}%
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-muted">
              <div className="h-1.5 rounded-full bg-primary" style={{ width: `${share}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
