"use client";

/**
 * Admin Survey Responses page — per-question aggregates + paginated
 * response browser + CSV export.
 *
 *   /events/[eventId]/survey/responses
 *
 * Fetches from GET /api/events/[eventId]/survey/responses. The
 * aggregator response is computed server-side over ALL responses
 * (not just the current page) so the histogram + means reflect
 * the full picture regardless of pagination.
 *
 * CSV export hits /api/events/[eventId]/survey/responses/export
 * directly as a normal `<a download>` link — the server streams
 * the CSV with the right Content-Disposition.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  Loader2,
  PenLine,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  SurveyAnswerValue,
  SurveyConfig,
} from "@/lib/survey/schema";
import type { QuestionAggregate } from "@/lib/survey/aggregate";

interface ResponsesPayload {
  event: { id: string; name: string };
  config: SurveyConfig;
  totalCount: number;
  aggregates: QuestionAggregate[];
  page: number;
  pageSize: number;
  totalPages: number;
  responses: Array<{
    id: string;
    submittedAt: string;
    registrant: {
      firstName: string;
      lastName: string;
      email: string;
    } | null;
    answers: Record<string, SurveyAnswerValue>;
  }>;
}

const PAGE_SIZE = 50;

export default function SurveyResponsesPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  const [data, setData] = useState<ResponsesPayload | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Load ─────────────────────────────────────────────────────────────

  const load = useCallback(
    async (targetPage: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/events/${eventId}/survey/responses?page=${targetPage}&pageSize=${PAGE_SIZE}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(typeof body.error === "string" ? body.error : "Failed to load responses.");
          return;
        }
        const payload = (await res.json()) as ResponsesPayload;
        setData(payload);
      } catch (err) {
        console.error("survey-responses:load-failed", err);
        setError("Failed to load responses. Please refresh.");
      } finally {
        setLoading(false);
      }
    },
    [eventId],
  );

  useEffect(() => {
    void load(page);
  }, [load, page]);

  // ── Derived ──────────────────────────────────────────────────────────

  const exportUrl = useMemo(
    () => `/api/events/${eventId}/survey/responses/export`,
    [eventId],
  );

  // ── Render ───────────────────────────────────────────────────────────

  if (loading && !data) {
    return (
      <div className="container py-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container max-w-4xl py-8">
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" className="mt-4" onClick={() => void load(page)}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="container max-w-6xl py-8">
      <div className="mb-6">
        <Link
          href={`/events/${eventId}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3 mr-1" />
          Back to event
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">Survey Responses</h1>
          <p className="text-muted-foreground mt-1">
            {data.totalCount === 0
              ? "No responses yet."
              : `${data.totalCount} response${data.totalCount === 1 ? "" : "s"} for ${data.event.name}.`}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link href={`/events/${eventId}/survey`}>
            <Button variant="outline" size="sm">
              <PenLine className="h-3.5 w-3.5 mr-1.5" />
              Edit survey
            </Button>
          </Link>
          {data.totalCount > 0 ? (
            <a href={exportUrl} download>
              <Button size="sm">
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Export CSV
              </Button>
            </a>
          ) : null}
        </div>
      </div>

      {data.totalCount === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <ClipboardList className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground mb-2">
              No survey responses have been submitted yet.
            </p>
            <p className="text-xs text-muted-foreground">
              Send invitations from the{" "}
              <Link
                href={`/events/${eventId}/communications`}
                className="underline hover:text-foreground"
              >
                Communications page
              </Link>{" "}
              to start collecting feedback.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Per-question aggregates */}
          <div className="space-y-3 mb-8">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Question summaries
            </h2>
            {data.aggregates.map((agg) => (
              <QuestionAggregateCard key={agg.questionId} aggregate={agg} />
            ))}
          </div>

          {/* Individual responses */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Individual responses</CardTitle>
              <CardDescription className="text-xs">
                Showing {(data.page - 1) * data.pageSize + 1}–
                {Math.min(data.page * data.pageSize, data.totalCount)} of{" "}
                {data.totalCount}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">Submitted</TableHead>
                      <TableHead>Registrant</TableHead>
                      {data.config.map((q) => (
                        <TableHead key={q.id} className="whitespace-nowrap text-xs">
                          {truncate(q.label, 40)}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.responses.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                          {new Date(r.submittedAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-sm">
                          {r.registrant ? (
                            <div>
                              <div className="font-medium">
                                {r.registrant.firstName} {r.registrant.lastName}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {r.registrant.email}
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">
                              Unlinked
                            </span>
                          )}
                        </TableCell>
                        {data.config.map((q) => (
                          <TableCell key={q.id} className="text-xs align-top max-w-xs">
                            {renderAnswerCell(r.answers[q.id])}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pager */}
              {data.totalPages > 1 ? (
                <div className="flex items-center justify-between mt-4">
                  <div className="text-xs text-muted-foreground">
                    Page {data.page} of {data.totalPages}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={data.page <= 1 || loading}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={data.page >= data.totalPages || loading}
                      onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                    >
                      Next
                      <ChevronRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function QuestionAggregateCard({ aggregate }: { aggregate: QuestionAggregate }) {
  return (
    <Card>
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant="secondary" className="text-xs shrink-0">
              {aggregate.type === "rating_1_to_5"
                ? "Rating"
                : aggregate.type === "single_select"
                  ? "Select"
                  : "Text"}
            </Badge>
            <span className="text-sm font-medium truncate">{aggregate.label}</span>
          </div>
          <span className="text-xs text-muted-foreground shrink-0">
            {aggregate.count} response{aggregate.count === 1 ? "" : "s"}
          </span>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0 border-t">
        <div className="pt-3">
          {aggregate.type === "rating_1_to_5" ? (
            <RatingChart aggregate={aggregate} />
          ) : aggregate.type === "single_select" ? (
            <SelectChart aggregate={aggregate} />
          ) : (
            <TextResponses aggregate={aggregate} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RatingChart({
  aggregate,
}: {
  aggregate: Extract<QuestionAggregate, { type: "rating_1_to_5" }>;
}) {
  const max = Math.max(1, ...aggregate.distribution);
  return (
    <div>
      <div className="flex items-center justify-between mb-2 text-xs">
        <span className="text-muted-foreground">
          Mean:{" "}
          <span className="font-medium text-foreground">
            {aggregate.mean === null ? "—" : aggregate.mean.toFixed(2)}
          </span>
        </span>
        <span className="text-muted-foreground">/ 5.00</span>
      </div>
      <div className="space-y-1.5">
        {[1, 2, 3, 4, 5].map((n) => {
          const count = aggregate.distribution[n - 1];
          const widthPct = (count / max) * 100;
          const pctOfTotal =
            aggregate.count === 0
              ? 0
              : Math.round((count / aggregate.count) * 100);
          return (
            <div key={n} className="flex items-center gap-2">
              <span className="text-xs tabular-nums w-3 text-muted-foreground">{n}</span>
              <div className="flex-1 h-5 bg-muted rounded overflow-hidden">
                <div
                  className="h-full bg-primary/80"
                  style={{ width: `${widthPct}%` }}
                />
              </div>
              <span className="text-xs tabular-nums w-16 text-right text-muted-foreground">
                {count} ({pctOfTotal}%)
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SelectChart({
  aggregate,
}: {
  aggregate: Extract<QuestionAggregate, { type: "single_select" }>;
}) {
  const allCounts = { ...aggregate.counts, ...aggregate.orphaned };
  const max = Math.max(1, ...Object.values(allCounts));
  const entries = Object.entries(aggregate.counts);
  const orphanedEntries = Object.entries(aggregate.orphaned);
  return (
    <div className="space-y-1.5">
      {entries.map(([opt, count]) => {
        const widthPct = (count / max) * 100;
        const pctOfTotal =
          aggregate.count === 0 ? 0 : Math.round((count / aggregate.count) * 100);
        return (
          <div key={opt} className="flex items-center gap-2">
            <span className="text-xs w-40 truncate text-muted-foreground" title={opt}>
              {opt}
            </span>
            <div className="flex-1 h-5 bg-muted rounded overflow-hidden">
              <div className="h-full bg-primary/80" style={{ width: `${widthPct}%` }} />
            </div>
            <span className="text-xs tabular-nums w-16 text-right text-muted-foreground">
              {count} ({pctOfTotal}%)
            </span>
          </div>
        );
      })}
      {orphanedEntries.length > 0 ? (
        <div className="mt-3 pt-3 border-t">
          <div className="text-xs text-amber-700 mb-1.5">
            Orphaned answers (option no longer in the survey)
          </div>
          {orphanedEntries.map(([opt, count]) => (
            <div key={opt} className="flex items-center gap-2">
              <span className="text-xs w-40 truncate text-amber-700" title={opt}>
                {opt}
              </span>
              <div className="flex-1 h-5 bg-amber-50 rounded overflow-hidden">
                <div className="h-full bg-amber-400" style={{ width: `${(count / max) * 100}%` }} />
              </div>
              <span className="text-xs tabular-nums w-16 text-right text-muted-foreground">
                {count}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TextResponses({
  aggregate,
}: {
  aggregate: Extract<QuestionAggregate, { type: "text" }>;
}) {
  const SHOW = 10;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? aggregate.responses : aggregate.responses.slice(0, SHOW);
  if (aggregate.responses.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">No text responses yet.</p>
    );
  }
  return (
    <div className="space-y-2">
      {visible.map((r) => (
        <div key={r.responseId} className="text-xs border rounded p-2 bg-muted/30">
          <div className="text-foreground whitespace-pre-wrap break-words">{r.value}</div>
          <div className="text-muted-foreground tabular-nums mt-1 text-[10px]">
            {r.submittedAt.toLocaleString()}
          </div>
        </div>
      ))}
      {aggregate.responses.length > SHOW ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? `Show first ${SHOW}`
            : `Show ${aggregate.responses.length - SHOW} more`}
        </Button>
      ) : null}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function renderAnswerCell(value: SurveyAnswerValue | undefined): React.ReactNode {
  if (value === undefined || value === null || value === "") {
    return <span className="text-muted-foreground/50">—</span>;
  }
  if (typeof value === "number") {
    return <span className="tabular-nums">{value}</span>;
  }
  return <span className="line-clamp-2 whitespace-pre-wrap break-words">{value}</span>;
}
