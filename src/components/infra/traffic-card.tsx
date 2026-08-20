"use client";

/**
 * Traffic card for /admin/infra.
 *
 * Reads the hourly snapshot produced on the host by
 * scripts/nginx-traffic-snapshot.sh. See src/lib/infra/nginx-traffic.ts for why
 * the app cannot read /var/log/nginx directly.
 *
 * WHAT THIS IS AND IS NOT, because the distinction decides how it is read:
 * every HTTP request nginx served, bots and monitoring and static assets
 * included. That makes it a LOAD signal, which is why it sits on the infra page
 * beside CPU credits. It is NOT a visitor count. Human visitor numbers come
 * from the analytics beacon on the event Analytics page. The card says so
 * rather than leaving someone to assume.
 *
 * The types are declared here rather than imported from the reader because the
 * reader is server-only (node:fs, the pino logger). A type-only import would be
 * erased and safe today, but one careless edit turning it into a value import
 * bundles node:fs into the browser as undefined, which fails silently at build
 * time and shows up as a click that does nothing. The page does the same.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Loader2, AlertTriangle, RefreshCw, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type SplitCount = [number, number]; // [human, bot]

interface Bucket {
  h: string; // UTC hour, "YYYY-MM-DDTHH"
  total: number;
  bot: number;
  s2: number;
  s3: number;
  s4: number;
  s5: number;
  public: SplitCount;
  app: SplitCount;
  api: SplitCount;
  asset: SplitCount;
  health: SplitCount;
  other: SplitCount;
}

interface Traffic {
  generatedAt: string;
  windowDays: number;
  archiveDays: number;
  oldestBucket: string;
  newestBucket: string;
  parsed: number;
  skipped: number;
  malformed: number;
  offsetSkew: number;
  buckets: Bucket[];
  topPaths: { path: string; count: number }[];
  topStaffPaths: { path: string; count: number }[];
  topReferrers: { host: string; count: number }[];
  ageMinutes: number;
  stale: boolean;
}

interface Payload {
  status: "ok" | "error" | "unconfigured" | "operator-only";
  error?: string;
  info: Traffic | null;
}

type Category = "all" | "public" | "app" | "api" | "asset" | "health" | "other";

/**
 * nginx itself keeps only about a fortnight: logrotate is `daily` with
 * `rotate 14`, so the box holds today plus fourteen rotations and deletes the
 * rest. The snapshot script accumulates its own archive on top of that, so
 * coverage GROWS from roughly fifteen days towards a year as it runs.
 *
 * Which means a fixed "30d" button is a lie on day one: it would offer a range
 * the data cannot cover and silently render fifteen days under a thirty-day
 * label. Options are therefore filtered against what actually exists
 * (`availableRanges` below) and appear as the archive fills.
 */
const RANGES = [
  { key: "24h", label: "24h", hours: 24 },
  { key: "7d", label: "7d", hours: 24 * 7 },
  { key: "30d", label: "30d", hours: 24 * 30 },
  { key: "90d", label: "90d", hours: 24 * 90 },
  { key: "all", label: "All", hours: Number.POSITIVE_INFINITY },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

/** Offer a range only when the archive covers most of it. */
const COVERAGE_REQUIRED = 0.8;

/**
 * Public attendee pages are listed before the staff dashboard, and separately,
 * because they are the question this card is usually opened to answer. Merged
 * into one "Pages" bucket the staff traffic wins on concentration and hides
 * the attendee traffic completely.
 */
const CATEGORIES: { key: Category; label: string }[] = [
  { key: "all", label: "All" },
  { key: "public", label: "Public" },
  { key: "app", label: "Admin" },
  { key: "api", label: "API" },
  { key: "asset", label: "Assets" },
  { key: "health", label: "Health" },
  { key: "other", label: "Other" },
];

/** "2026-08-20T08" is UTC. Everything shown to the operator is local time. */
function bucketDate(h: string): Date {
  return new Date(`${h}:00:00Z`);
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

/**
 * How many requests this bucket contributes under the current filters.
 *
 * Category and bot-exclusion compose because the snapshot stores a
 * [human, bot] pair per category. Status class deliberately does NOT compose
 * with them: that would need a category-by-status-by-bot cross product per
 * hour, which is forty counters an hour for a breakdown nobody filters on. The
 * error figures below are labelled as covering all traffic for that reason.
 */
function valueOf(b: Bucket, cat: Category, excludeBots: boolean): number {
  if (cat === "all") return excludeBots ? b.total - b.bot : b.total;
  const pair = b[cat];
  return excludeBots ? pair[0] : pair[0] + pair[1];
}

export function TrafficCard() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<RangeKey>("7d");
  const [category, setCategory] = useState<Category>("all");
  const [excludeBots, setExcludeBots] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/infra/traffic");
      if (!res.ok) {
        // A failed fetch must not render as an empty chart. An empty traffic
        // chart reads as "no traffic", which is the opposite of "we do not
        // know", and someone could plan a maintenance window around it.
        setData({ status: "error", info: null, error: `Request failed (${res.status})` });
        return;
      }
      setData((await res.json()) as Payload);
    } catch {
      setData({ status: "error", info: null, error: "Could not reach the server." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const info = data?.status === "ok" ? data.info : null;

  // Which ranges the data can honestly support. Always keep the shortest and
  // "All": the first is always answerable, the second is self-describing.
  const availableRanges = useMemo(() => {
    if (!info || info.buckets.length === 0) return RANGES;
    const spanHours =
      (Date.now() - bucketDate(info.buckets[0].h).getTime()) / 3600_000;
    return RANGES.filter(
      (r) =>
        r.key === "24h" ||
        r.hours === Number.POSITIVE_INFINITY ||
        spanHours >= r.hours * COVERAGE_REQUIRED,
    );
  }, [info]);

  // Derived, not synced through an effect: if the default range is not yet
  // supported by the data, fall back rather than render an unreachable state.
  const effectiveRange = availableRanges.some((r) => r.key === range) ? range : "all";

  const view = useMemo(() => {
    if (!info || info.buckets.length === 0) return null;

    const hours = RANGES.find((r) => r.key === effectiveRange)!.hours;
    const cutoffMs =
      hours === Number.POSITIVE_INFINITY ? 0 : Date.now() - hours * 3600_000;
    const inRange = info.buckets.filter((b) => bucketDate(b.h).getTime() >= cutoffMs);
    if (inRange.length === 0) return null;

    const total = inRange.reduce((a, b) => a + valueOf(b, category, excludeBots), 0);
    const publicViews = inRange.reduce((a, b) => a + b.public[0], 0);
    const errors = inRange.reduce((a, b) => a + b.s4 + b.s5, 0);
    const serverErrors = inRange.reduce((a, b) => a + b.s5, 0);
    const allRequests = inRange.reduce((a, b) => a + b.total, 0);

    // Hourly detail is unreadable past a couple of days, so roll up to days.
    const daily = hours > 48;
    const grouped = new Map<string, { label: string; value: number; at: Date }>();
    for (const b of inRange) {
      const at = bucketDate(b.h);
      const key = daily
        ? at.toLocaleDateString(undefined, { month: "short", day: "numeric" })
        : b.h;
      const prev = grouped.get(key);
      const value = valueOf(b, category, excludeBots);
      if (prev) prev.value += value;
      else grouped.set(key, { label: key, value, at });
    }
    const series = [...grouped.values()].sort((a, b) => a.at.getTime() - b.at.getTime());

    // Which hour of the DAY is consistently quietest, averaged across the
    // range. That is the question a maintenance window actually asks; a single
    // quietest bucket could be a one-off and would be a bad thing to plan on.
    const byHour = new Array(24).fill(0).map(() => ({ sum: 0, n: 0 }));
    for (const b of inRange) {
      const slot = byHour[bucketDate(b.h).getHours()];
      slot.sum += valueOf(b, category, excludeBots);
      slot.n += 1;
    }
    const observed = byHour
      .map((s, hour) => ({ hour, avg: s.n ? s.sum / s.n : Number.POSITIVE_INFINITY, n: s.n }))
      .filter((s) => s.n > 0);
    const quietest = observed.length
      ? observed.reduce((a, b) => (b.avg < a.avg ? b : a))
      : null;

    return { series, total, publicViews, errors, serverErrors, allRequests, quietest, daily, buckets: inRange.length };
  }, [info, effectiveRange, category, excludeBots]);

  const peak = view ? Math.max(1, ...view.series.map((s) => s.value)) : 1;

  return (
    <Card id="traffic" className="lg:col-span-2 scroll-mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" /> Traffic
          <span className="ml-auto flex items-center gap-2 text-xs font-normal text-muted-foreground">
            {info && (
              <span>
                {info.stale ? (
                  <span className="text-amber-600">
                    stale, {Math.floor(info.ageMinutes / 60)}h old
                  </span>
                ) : (
                  <>updated {info.ageMinutes}m ago</>
                )}
              </span>
            )}
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {loading && !data && (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading traffic…
          </p>
        )}

        {data?.status === "error" && (
          <p className="text-sm text-amber-600 flex items-start gap-1.5">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            {data.error}
          </p>
        )}

        {data?.status === "unconfigured" && (
          <p className="text-sm text-muted-foreground">{data.error}</p>
        )}

        {data?.status === "operator-only" && (
          <p className="text-sm text-muted-foreground">
            Platform operator only. nginx cannot tell which organization a request
            belonged to, so these totals span every tenant on the instance.
          </p>
        )}

        {info && (
          <>
            {/* Filters */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground mr-1">Range</span>
                {availableRanges.map((r) => (
                  <Button
                    key={r.key}
                    variant={effectiveRange === r.key ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setRange(r.key)}
                  >
                    {r.label}
                  </Button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground mr-1">Show</span>
                {CATEGORIES.map((c) => (
                  <Button
                    key={c.key}
                    variant={category === c.key ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setCategory(c.key)}
                  >
                    {c.label}
                  </Button>
                ))}
              </div>
              <Button
                variant={excludeBots ? "default" : "outline"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setExcludeBots((v) => !v)}
                title="Bots, crawlers and uptime monitors are a large share of raw requests"
              >
                {excludeBots ? "Bots hidden" : "Bots shown"}
              </Button>
            </div>

            {!view ? (
              <p className="text-sm text-muted-foreground">No traffic in this range.</p>
            ) : (
              <>
                {/* Headline numbers */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Stat label="Requests" value={fmtInt(view.total)} hint={excludeBots ? "bots excluded" : "all sources"} />
                  <Stat label="Public page views" value={fmtInt(view.publicViews)} hint="attendee pages, no bots" />
                  <Stat
                    label="Error rate"
                    value={`${view.allRequests ? ((view.errors / view.allRequests) * 100).toFixed(1) : "0.0"}%`}
                    hint={`${fmtInt(view.serverErrors)} server errors`}
                    tone={view.serverErrors > 0 ? "warn" : undefined}
                  />
                  <Stat
                    label="Quietest hour"
                    value={
                      view.quietest
                        ? `${String(view.quietest.hour).padStart(2, "0")}:00`
                        : "—"
                    }
                    hint={view.quietest ? `~${Math.round(view.quietest.avg)}/h, your time` : ""}
                    icon={<Moon className="h-3 w-3" />}
                  />
                </div>

                {/* Chart */}
                <div>
                  <div className="flex items-end gap-[3px] h-28">
                    {view.series.map((s) => (
                      <div
                        key={s.label}
                        className="flex-1 flex flex-col justify-end h-full"
                        title={`${view.daily ? s.label : s.at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" })} — ${fmtInt(s.value)} requests`}
                      >
                        {s.value === 0 ? (
                          <div className="w-full h-[2px] bg-muted rounded-sm" />
                        ) : (
                          <div
                            className="w-full bg-primary/70 rounded-t-sm min-h-[2px]"
                            style={{ height: `${Math.max(2, (s.value / peak) * 100)}%` }}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between text-[10px] text-muted-foreground mt-1 font-mono">
                    <span>{view.series[0]?.at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                    <span>{view.daily ? "per day" : "per hour"} · peak {fmtInt(peak)}</span>
                    <span>now</span>
                  </div>
                </div>

                {/* Top lists */}
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-1">
                  <TopList
                    title="Top public pages"
                    note={`attendees, last ${info.windowDays}d`}
                    rows={info.topPaths.map((p) => ({ label: p.path, count: p.count }))}
                  />
                  <TopList
                    title="Top referrers"
                    note={`attendees, last ${info.windowDays}d`}
                    rows={info.topReferrers.map((r) => ({ label: r.host, count: r.count }))}
                  />
                  <TopList
                    title="Top admin pages"
                    note={`staff, last ${info.windowDays}d`}
                    rows={info.topStaffPaths.map((p) => ({ label: p.path, count: p.count }))}
                  />
                </div>

                <p className="text-[11px] text-muted-foreground leading-relaxed border-t pt-3">
                  Every HTTP request nginx served, so this is server load rather than a
                  visitor count. History spans{" "}
                  <span className="font-mono">{info.oldestBucket || "—"}</span> to{" "}
                  <span className="font-mono">{info.newestBucket || "—"}</span> (UTC).
                  nginx keeps only the last 14 days and deletes the rest, so longer ranges
                  appear here as the accumulated archive fills, up to {info.archiveDays}{" "}
                  days. Error rate covers all traffic and is not narrowed by the filters
                  above.
                  {info.malformed > 0 && ` ${fmtInt(info.malformed)} unparseable lines were skipped.`}
                  {info.offsetSkew > 0 && ` ${fmtInt(info.offsetSkew)} lines were not UTC and may be misplaced.`}
                </p>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warn";
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-2.5">
      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </p>
      <p className={`text-lg font-semibold tabular-nums ${tone === "warn" ? "text-amber-600" : ""}`}>
        {value}
      </p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TopList({
  title,
  note,
  rows,
}: {
  title: string;
  note: string;
  rows: { label: string; count: number }[];
}) {
  if (rows.length === 0) {
    return (
      <div>
        <p className="text-xs font-medium mb-1.5">{title}</p>
        <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
      </div>
    );
  }
  const top = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div>
      <p className="text-xs font-medium mb-1.5">
        {title} <span className="font-normal text-muted-foreground">· {note}</span>
      </p>
      <ul className="space-y-1">
        {rows.slice(0, 8).map((r) => (
          <li key={r.label} className="relative text-xs">
            <div
              className="absolute inset-y-0 left-0 bg-primary/10 rounded-sm"
              style={{ width: `${(r.count / top) * 100}%` }}
            />
            <div className="relative flex justify-between gap-2 px-1.5 py-0.5">
              <span className="truncate font-mono" title={r.label}>
                {r.label}
              </span>
              <span className="tabular-nums text-muted-foreground shrink-0">
                {fmtInt(r.count)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
