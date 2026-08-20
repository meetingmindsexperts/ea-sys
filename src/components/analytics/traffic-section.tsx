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
import { Button } from "@/components/ui/button";
import { Loader2, TrendingDown, Globe, AlertTriangle } from "lucide-react";

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
  hitsRead: number;
  truncated: boolean;
  timeZone: string;
}

const RANGES = [7, 30, 90, 365] as const;

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function duration(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
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
  const peak = s ? Math.max(1, ...s.daily.map((d) => d.pageviews)) : 1;
  const funnelTop = data?.funnel?.[0]?.count ?? 0;

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
        <div className="flex shrink-0 items-center gap-1">
          {RANGES.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={days === r ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              onClick={() => setDays(r)}
            >
              {r === 365 ? "1y" : `${r}d`}
            </Button>
          ))}
        </div>
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
            {data.funnel.length > 0 && funnelTop > 0 && (
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-700">
                  <TrendingDown className="h-3.5 w-3.5" /> Registration funnel
                </p>
                <div className="space-y-2">
                  {data.funnel.map((step, i) => (
                    <div key={step.name}>
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="text-slate-700">{step.label}</span>
                        <span className="tabular-nums font-medium text-slate-900">
                          {step.count.toLocaleString()}
                          <span className="ml-2 text-xs font-normal text-slate-500">
                            {pct(step.conversionRate)}
                          </span>
                        </span>
                      </div>
                      <div className="mt-1 h-3 overflow-hidden rounded bg-slate-100">
                        <div
                          className="h-full rounded bg-primary/70"
                          style={{ width: `${Math.min(100, (step.count / funnelTop) * 100)}%` }}
                        />
                      </div>
                      {i > 0 && step.dropOff > 0 && (
                        <p className="mt-0.5 text-[11px] text-slate-500">
                          {step.dropOff.toLocaleString()} left here ({pct(step.dropOffRate)})
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Daily shape */}
            <div>
              <div className="flex h-20 items-end gap-[2px]">
                {s.daily.map((d) => (
                  <div
                    key={d.date}
                    className="flex h-full flex-1 flex-col justify-end"
                    title={`${d.date} — ${d.pageviews} views, ${d.visitors} visitors`}
                  >
                    {d.pageviews === 0 ? (
                      <div className="h-[2px] w-full rounded-sm bg-slate-100" />
                    ) : (
                      <div
                        className="w-full rounded-t-sm bg-primary/60"
                        style={{ height: `${Math.max(3, (d.pageviews / peak) * 100)}%` }}
                      />
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
                <span>{s.daily[0]?.date}</span>
                <span>views per day · peak {peak.toLocaleString()}</span>
                <span>today</span>
              </div>
            </div>

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

            <p className="border-t pt-3 text-[11px] leading-relaxed text-slate-500">
              Visitors are counted without cookies and cannot be identified or followed between
              days. Bots and link previews are excluded, so these numbers are lower, and more
              honest, than raw server hits. Days are grouped in the event&apos;s own timezone
              ({data.timeZone}).
              {data.truncated &&
                ` Only the first ${data.hitsRead.toLocaleString()} hits in this range were counted.`}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warn";
}) {
  return (
    <div className="rounded-md border bg-slate-50/60 p-3">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${tone === "warn" ? "text-amber-600" : "text-slate-900"}`}>
        {value}
      </p>
      {hint && <p className="text-[10px] text-slate-500">{hint}</p>}
    </div>
  );
}

function TopList({
  title,
  rows,
  empty,
  icon,
}: {
  title: string;
  rows: { label: string; n: number }[];
  empty: string;
  icon?: React.ReactNode;
}) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-slate-700">
        {icon}
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-400">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {rows.slice(0, 6).map((r) => (
            <li key={r.label} className="relative text-xs">
              <div
                className="absolute inset-y-0 left-0 rounded-sm bg-primary/10"
                style={{ width: `${(r.n / max) * 100}%` }}
              />
              <div className="relative flex justify-between gap-2 px-1.5 py-0.5">
                <span className="truncate font-mono" title={r.label}>
                  {r.label}
                </span>
                <span className="shrink-0 tabular-nums text-slate-500">{r.n.toLocaleString()}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
