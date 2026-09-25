"use client";

/**
 * Public-page traffic for one event, on the Analytics page.
 *
 * The number this exists to produce is the DENOMINATOR. Every other figure on
 * that page describes people who completed something; this one describes the
 * people who looked and left, which is the question nobody could previously
 * answer.
 *
 * Loaded from its own endpoint rather than the page's existing analytics call,
 * because it reads a different table and, for a while after deploy, will be
 * legitimately empty on events whose traffic predates the beacon. A slow or
 * missing traffic query must not be able to take the registration figures down
 * with it.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Globe, AlertTriangle } from "lucide-react";
import { DailyBars, FunnelBars, Kpi, PrivacyNote, RangePicker, TopList, duration, measuredFromText, pct } from "./traffic-parts";

interface FunnelStep {
  name: string;
  label: string;
  count: number;
  conversionRate: number;
  stepRate: number;
  dropOff: number;
  dropOffRate: number;
}

interface TrafficResponse {
  range: { days: number; from: string; to: string };
  summary: {
    pageviews: number;
    visitors: number;
    sessions: number;
    bounceRate: number;
    avgDurationMs: number | null;
    avgScrollDepth: number | null;
    daily: { date: string; pageviews: number; visitors: number }[];
    topPages: { routePattern: string; examplePath: string; pageviews: number; visitors: number }[];
    topReferrers: { label: string; visitors: number }[];
    devices: { label: string; visitors: number }[];
  };
  funnel: FunnelStep[];
  measuredFrom: string | null;
  hitsRead: number;
  truncated: boolean;
  timeZone: string;
}

export function TrafficSection({ eventId }: { eventId: string }) {
  const [days, setDays] = useState<number>(30);

  const { data, isLoading, isError } = useQuery<TrafficResponse>({
    queryKey: ["event-traffic", eventId, days],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/analytics/traffic?days=${days}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return res.json();
    },
    staleTime: 60_000,
  });

  const s = data?.summary;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
        <div>
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Public page traffic
          </CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            People who visited this event&apos;s public pages, whether or not they registered.
          </p>
        </div>
        <RangePicker days={days} onChange={setDays} />
      </CardHeader>

      <CardContent className="space-y-5">
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading traffic…
          </p>
        )}

        {isError && (
          // Never an empty chart on failure: "no traffic" and "we could not
          // find out" are different answers and only one of them is honest.
          <p className="flex items-start gap-1.5 text-sm text-amber-600">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            Couldn&apos;t load traffic for this event. Try again shortly.
          </p>
        )}

        {s && s.pageviews === 0 && (
          <div className="rounded-md border border-dashed p-4 text-sm text-slate-500">
            <p className="font-medium text-slate-700">No traffic recorded yet.</p>
            <p className="mt-1">
              Measurement started when this feature was deployed, so visits before then are not
              counted. Anything older than that was never recorded and cannot be recovered.
            </p>
          </div>
        )}

        {s && s.pageviews > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Kpi label="Visitors" value={s.visitors.toLocaleString()} hint="unique people" />
              <Kpi label="Page views" value={s.pageviews.toLocaleString()} hint={`${s.sessions.toLocaleString()} visits`} />
              <Kpi
                label="Bounce rate"
                value={pct(s.bounceRate)}
                hint="left after one page"
                tone={s.bounceRate > 0.7 ? "warn" : undefined}
              />
              <Kpi
                label="Time on page"
                value={duration(s.avgDurationMs)}
                hint={s.avgScrollDepth === null ? "not yet measured" : `${s.avgScrollDepth}% scrolled`}
              />
            </div>

            {/* The funnel. The reason the feature exists. */}
            <FunnelBars
              steps={data.funnel}
              note={
                <>
                  &ldquo;Registered online&rdquo; counts registrations made through the public form in this
                  period. Imported, admin-added and speaker registrations are not counted, because those
                  people did not come through these pages. {measuredFromText(data.measuredFrom, data.range.from)}
                </>
              }
            />

            {/* Daily shape */}
            <DailyBars daily={s.daily} />

            <div className="grid gap-4 sm:grid-cols-3">
              <TopList
                title="Most visited"
                rows={s.topPages.map((p) => ({ label: p.examplePath, n: p.visitors }))}
                empty="No pages yet"
              />
              <TopList
                title="Came from"
                icon={<Globe className="h-3 w-3" />}
                rows={s.topReferrers.map((r) => ({ label: r.label, n: r.visitors }))}
                empty="All visits were direct"
              />
              <TopList
                title="Device"
                rows={s.devices.map((d) => ({ label: d.label, n: d.visitors }))}
                empty="Not recorded"
              />
            </div>

            <PrivacyNote timeZone={data.timeZone} truncated={data.truncated} hitsRead={data.hitsRead} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
