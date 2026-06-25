"use client";

/**
 * Auto-issue (survey-gated) analytics card — Phase 2 observability on the
 * certificates page "Issue" tab. Shows the retry/backoff state of
 * survey-completed registrations + the delivery state of the auto runs,
 * so an organizer can see at a glance whether survey-gated certs are
 * flowing and what (if anything) is stuck. Read-only; polls every ~20s.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
  Sparkles,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface AutoIssueAnalytics {
  cme: { accredited: boolean; hours: number | null; bodies: string[] };
  registrations: {
    pending: number;
    retrying: number;
    resolved: number;
    gaveUp: number;
    total: number;
  };
  certsAutoIssued: number;
  autoRuns: { inFlight: number; completed: number; failed: number };
  templates: { configured: number; missingTag: number; missingTagNames: string[] };
  recentErrors: Array<{
    registrationId: string;
    name: string;
    email: string | null;
    attempts: number;
    gaveUp: boolean;
    error: string | null;
  }>;
}

function StatTile({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "bad"
          ? "text-red-600"
          : "text-foreground";
  return (
    <div className="rounded-md border px-3 py-2">
      <div className={`text-xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

export function AutoIssueAnalyticsCard({ eventId }: { eventId: string }) {
  const [showErrors, setShowErrors] = useState(false);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<AutoIssueAnalytics>({
    queryKey: ["cert-auto-issue-analytics", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/certificates/auto-issue/analytics`);
      if (!res.ok) throw new Error(`Failed to load auto-issue analytics (${res.status})`);
      return res.json();
    },
    refetchInterval: 20_000,
    staleTime: 10_000,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-cyan-600" />
              Auto-issue (survey-gated)
              {data &&
                (data.cme.accredited ? (
                  <Badge variant="outline" className="border-emerald-300 text-emerald-700">
                    CME accredited
                    {data.cme.hours != null ? ` · ${data.cme.hours} hrs` : ""}
                    {data.cme.bodies.length > 0 ? ` · ${data.cme.bodies.join(", ")}` : ""}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">
                    Not CME-accredited
                  </Badge>
                ))}
            </CardTitle>
            <CardDescription>
              Certificates issued automatically when a registrant completes the survey.
              Configure per template in the Templates tab (toggle &ldquo;Auto-issue on
              survey&rdquo; + a tag).
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Refresh auto-issue analytics"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : isError || !data ? (
          <div className="text-sm text-red-600">Couldn&apos;t load auto-issue analytics.</div>
        ) : data.templates.configured === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No templates are set to auto-issue on survey completion. Open a template in the
            Templates tab and enable &ldquo;Auto-issue on survey&rdquo; with a tag to start
            issuing certificates automatically.
          </div>
        ) : (
          <>
            {data.templates.missingTag > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  {data.templates.missingTag} auto-issue{" "}
                  {data.templates.missingTag === 1 ? "template has" : "templates have"} no tag
                  set — they will never match anyone. Add a tag in the Templates tab:{" "}
                  <span className="font-medium">{data.templates.missingTagNames.join(", ")}</span>.
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <StatTile label="Certs issued" value={data.certsAutoIssued} tone="good" />
              <StatTile label="In flight" value={data.autoRuns.inFlight} tone="warn" />
              <StatTile label="Resolved" value={data.registrations.resolved} tone="good" />
              <StatTile label="Pending" value={data.registrations.pending} />
              <StatTile label="Retrying" value={data.registrations.retrying} tone="warn" />
              <StatTile label="Gave up" value={data.registrations.gaveUp} tone="bad" />
            </div>

            {data.autoRuns.failed > 0 && (
              <div className="text-xs text-red-600">
                {data.autoRuns.failed} auto-issue delivery run
                {data.autoRuns.failed === 1 ? "" : "s"} failed — check the Runs list / logs.
              </div>
            )}

            {data.recentErrors.length > 0 && (
              <div className="rounded-md border">
                <button
                  type="button"
                  onClick={() => setShowErrors((s) => !s)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium"
                >
                  <span className="flex items-center gap-2">
                    {showErrors ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                    Recent errors ({data.recentErrors.length})
                  </span>
                </button>
                {showErrors && (
                  <div className="divide-y border-t">
                    {data.recentErrors.map((e) => (
                      <div key={e.registrationId} className="px-3 py-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{e.name}</span>
                          {e.email && <span className="text-muted-foreground">{e.email}</span>}
                          <Badge variant={e.gaveUp ? "destructive" : "outline"} className="ml-auto">
                            {e.gaveUp ? "Gave up" : `Attempt ${e.attempts}`}
                          </Badge>
                        </div>
                        {e.error && (
                          <div className="mt-1 break-words text-muted-foreground">{e.error}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
