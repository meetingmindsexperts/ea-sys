"use client";

/**
 * Analytics: public-site traffic across the organisation's events (Sep 25,
 * 2026). The per-event card answers "how did this event's pages do"; this page
 * answers "how is our public traffic doing, which events draw visitors, which
 * websites send them, and how many register online". Data from
 * /api/analytics/traffic; the drawing pieces are shared with the per-event
 * card (src/components/analytics/traffic-parts.tsx).
 */

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, BarChart3, Globe, Loader2 } from "lucide-react";
import { DailyBars, FunnelBars, Kpi, PrivacyNote, RangePicker, Sparkline, TopList, measuredFromText, pct, type FunnelStepView } from "@/components/analytics/traffic-parts";

interface OrgTrafficResponse {
  range: { days: number; from: string; to: string };
  eventsInScope: number;
  summary: {
    pageviews: number;
    visitors: number;
    sessions: number;
    bounceRate: number;
    daily: { date: string; pageviews: number; visitors: number }[];
    topPages: { routePattern: string; examplePath: string; pageviews: number; visitors: number }[];
    topReferrers: { label: string; visitors: number }[];
    devices: { label: string; visitors: number }[];
  };
  funnel: FunnelStepView[];
  events: {
    eventId: string;
    name: string;
    visitors: number;
    registerVisitors: number;
    onlineRegistrations: number;
    conversionRate: number;
    topSource: string | null;
    daily: number[];
  }[];
  onlineRegistrations: number;
  measuredFrom: string | null;
  hitsRead: number;
  truncated: boolean;
  timeZone: string;
}

/** What each measured page type is, in words an organiser uses. */
const PAGE_TYPE: Record<string, string> = {
  "/e/:slug": "Event home",
  "/e/:slug/agenda": "Agenda",
  "/e/:slug/register": "Registration start",
  "/e/:slug/register/:category": "Registration form",
  "/e/:slug/session/:sessionId": "Session page",
};

export default function AnalyticsPage() {
  const [days, setDays] = useState<number>(30);
  const { data, isLoading, isError } = useQuery<OrgTrafficResponse>({
    queryKey: ["org-traffic", days],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/traffic?days=${days}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return res.json();
    },
    staleTime: 60_000,
  });

  const s = data?.summary;
  const registerVisitors = data?.funnel.find((f) => f.name === "register_viewed")?.count ?? 0;
  const countedFrom = data ? measuredFromText(data.measuredFrom, data.range.from) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            <BarChart3 className="h-6 w-6 text-primary" /> Analytics
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Visits to your events&apos; public pages, where they came from, and how many became online registrations.
          </p>
        </div>
        <RangePicker days={days} onChange={setDays} />
      </div>

      {isLoading && (
        <p className="flex items-center gap-2 py-16 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading traffic…
        </p>
      )}

      {isError && (
        <p className="flex items-start gap-1.5 text-sm text-amber-600">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Couldn&apos;t load traffic. Try again shortly.
        </p>
      )}

      {data && s && s.pageviews === 0 && data.onlineRegistrations === 0 && (
        <Card>
          <CardContent className="p-6 text-sm text-slate-500">
            <p className="font-medium text-slate-700">No public traffic in the last {days === 365 ? "year" : `${days} days`}.</p>
            <p className="mt-1">
              {data.eventsInScope === 0
                ? "You have no events to show here."
                : "Try a longer range. Visits are measured from August 20, 2026; nothing earlier was recorded."}
            </p>
          </CardContent>
        </Card>
      )}

      {data && s && (s.pageviews > 0 || data.onlineRegistrations > 0) && (
        <>
          {/* Headline */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Visitors" value={s.visitors.toLocaleString()} hint="counted per event" />
            <Kpi label="Page views" value={s.pageviews.toLocaleString()} hint={`${s.sessions.toLocaleString()} visits`} />
            <Kpi label="Opened a registration form" value={registerVisitors.toLocaleString()} hint={s.visitors ? `${pct(registerVisitors / s.visitors)} of visitors` : undefined} />
            <Kpi
              label="Registered online"
              value={data.onlineRegistrations.toLocaleString()}
              hint={s.visitors ? `${pct(data.onlineRegistrations / s.visitors)} of visitors` : "through the public form"}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold uppercase tracking-wide text-slate-700">From visit to registration</CardTitle>
              </CardHeader>
              <CardContent>
                <FunnelBars
                  title={null}
                  steps={data.funnel}
                  note={`Registered online counts registrations made through the public form in this period, across the events below. Imported, admin-added and speaker registrations are not counted.${countedFrom ? ` ${countedFrom}` : ""}`}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold uppercase tracking-wide text-slate-700">Traffic over time</CardTitle>
              </CardHeader>
              <CardContent>
                <DailyBars daily={s.daily} height="h-32" />
              </CardContent>
            </Card>
          </div>

          {/* By event */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-slate-700">
                By event ({data.events.length.toLocaleString()})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-md border border-slate-100">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Event</th>
                      <th className="px-3 py-2 text-right font-medium">Visitors</th>
                      <th className="px-3 py-2 text-right font-medium">Opened form</th>
                      <th className="px-3 py-2 text-right font-medium">Registered online</th>
                      <th className="px-3 py-2 text-right font-medium">Conversion</th>
                      <th className="px-3 py-2 font-medium">Top source</th>
                      <th className="px-3 py-2 font-medium">Trend</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.events.map((e) => (
                      <tr key={e.eventId} className="hover:bg-slate-50/50">
                        <td className="px-3 py-2">
                          <Link href={`/events/${e.eventId}/analytics`} className="font-medium text-slate-900 hover:text-primary hover:underline">
                            {e.name}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{e.visitors.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{e.registerVisitors.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{e.onlineRegistrations.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{e.visitors ? pct(e.conversionRate) : "—"}</td>
                        <td className="max-w-[220px] truncate px-3 py-2 font-mono text-xs text-slate-600" title={e.topSource ?? "Direct"}>
                          {e.topSource ?? "Direct"}
                        </td>
                        <td className="px-3 py-2">
                          <Sparkline values={e.daily} label={`${e.name}: page views per day`} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                Conversion is online registrations as a share of visitors. It can pass 100% when someone registered without a
                measured visit, for example with tracking blocked.{countedFrom ? ` ${countedFrom}` : ""}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="grid gap-6 p-6 sm:grid-cols-3">
              <TopList
                title="Websites sending visitors"
                icon={<Globe className="h-3 w-3" />}
                rows={s.topReferrers.map((r) => ({ label: r.label, n: r.visitors }))}
                empty="All visits were direct"
                limit={10}
              />
              <TopList
                title="Pages people visit"
                rows={s.topPages.map((p) => ({ label: PAGE_TYPE[p.routePattern] ?? p.routePattern, n: p.visitors }))}
                empty="No pages yet"
              />
              <TopList title="Device" rows={s.devices.map((d) => ({ label: d.label, n: d.visitors }))} empty="Not recorded" />
            </CardContent>
          </Card>

          <PrivacyNote
            timeZone={data.timeZone}
            truncated={data.truncated}
            hitsRead={data.hitsRead}
            extra="Someone who looked at two events counts once for each, so visitors add up across events."
          />
        </>
      )}
    </div>
  );
}
