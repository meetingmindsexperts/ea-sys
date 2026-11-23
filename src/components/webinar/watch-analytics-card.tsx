"use client";

/**
 * Watch analytics on the Webinar Console (Nov 23, 2026): how many were watching
 * each minute, what they watched on, and how our stream played for them. Read
 * from our own page's presence record (presence-report.ts watchAnalytics); no
 * names. Everything counts the people who reached the live view.
 */
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Activity } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useWebinarWatchAnalytics, type WebinarWatchAnalytics, type WebinarWatchBreakdown } from "@/hooks/use-api";

function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

export function WatchAnalyticsCard({ eventId, timezone }: { eventId: string; timezone: string }) {
  const query = useWebinarWatchAnalytics(eventId);
  const data = query.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4 text-emerald-600" />
          How people watched
        </CardTitle>
        <CardDescription>
          How many were watching each minute, the devices and browsers they used, and how the stream played for them.
          Counts everyone who reached the live view on our page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {query.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {query.isError ? (
          <p className="text-sm text-red-600">
            {query.error instanceof Error ? query.error.message : "Could not load the watch analytics."}
          </p>
        ) : null}
        {data && data.watched === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody has reached the live view yet.</p>
        ) : null}
        {data && data.watched > 0 ? <WatchAnalyticsBody data={data} timezone={timezone} /> : null}
      </CardContent>
    </Card>
  );
}

function WatchAnalyticsBody({ data, timezone }: { data: WebinarWatchAnalytics; timezone: string }) {
  return (
    <>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Watching over time</h3>
        <WatchingChart points={data.timeline} timezone={timezone} />
      </section>
      <section className="grid gap-6 md:grid-cols-2">
        <BreakdownList title="Device" entries={data.devices} total={data.watched} />
        <BreakdownList title="Watched via" entries={data.viewModes} total={data.watched} />
        <BreakdownList title="Browser" entries={data.browsers} total={data.watched} />
        <BreakdownList title="System" entries={data.systems} total={data.watched} />
      </section>
      <PlaybackSection playback={data.playback} />
      <p className="text-xs text-muted-foreground">
        Device, browser and system are read from the browser the person last watched on. Buffering is counted by our
        stream player only; the Zoom embed does not report it. Recorded since Nov 23, 2026, so earlier webinars show
        &quot;Unknown&quot;.
      </p>
    </>
  );
}

function BreakdownList({ title, entries, total }: { title: string; entries: WebinarWatchBreakdown[]; total: number }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="space-y-1.5">
        {entries.map((e) => (
          <li key={e.label} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate">{e.label}</span>
              <span className="tabular-nums text-muted-foreground">
                <span className="font-medium text-foreground">{e.count}</span> · {share(e.count, total)}
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-muted">
              <div className="h-1.5 rounded-full bg-primary" style={{ width: share(e.count, total) }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlaybackSection({ playback }: { playback: WebinarWatchAnalytics["playback"] }) {
  if (playback.streamViewers === 0) {
    return (
      <section className="space-y-1">
        <h3 className="text-sm font-medium">How the stream played</h3>
        <p className="text-sm text-muted-foreground">Nobody watched on our stream player, so there is no buffering to report.</p>
      </section>
    );
  }
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">How the stream played</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Watched our stream" value={String(playback.streamViewers)} />
        <Tile
          label="Buffered at least once"
          value={`${playback.buffered} (${share(playback.buffered, playback.streamViewers)})`}
        />
        <Tile label="Time spent buffering" value={formatSeconds(playback.stallSeconds)} />
        <Tile label="Player reconnects" value={String(playback.reconnects)} />
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">System</th>
              <th className="px-3 py-2 text-right font-medium">Viewers</th>
              <th className="px-3 py-2 text-right font-medium">Buffered</th>
              <th className="px-3 py-2 text-right font-medium">Time buffering</th>
              <th className="px-3 py-2 text-right font-medium">Reconnects</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {playback.bySystem.map((row) => (
              <tr key={row.system}>
                <td className="px-3 py-2">{row.system}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row.viewers}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {row.buffered} ({share(row.buffered, row.viewers)})
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatSeconds(row.stallSeconds)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row.reconnects}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const CHART_W = 600;
const CHART_H = 160;

/**
 * One series, so one hue and no legend. The SVG stretches to the card's width (the line keeps its 2px
 * with a non-scaling stroke); the axis labels, crosshair and readout are HTML over it, so text never
 * stretches. Hover or arrow keys pick a minute; the numbers are also in the table under the chart.
 */
function WatchingChart({ points, timezone }: { points: { at: string; watching: number }[]; timezone: string }) {
  const [active, setActive] = useState<number | null>(null);
  const clock = useMemo(
    () => new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }),
    [timezone],
  );
  const peak = Math.max(1, ...points.map((p) => p.watching));
  const peakPoint = points.reduce<{ at: string; watching: number } | null>(
    (best, p) => (best === null || p.watching > best.watching ? p : best),
    null,
  );

  if (points.length < 2) {
    return (
      <p className="text-sm text-muted-foreground">
        {points.length === 1
          ? `${points[0].watching} watching at ${clock.format(new Date(points[0].at))}. The chart needs at least two minutes.`
          : "No minutes recorded yet."}
      </p>
    );
  }

  const x = (i: number) => (i / (points.length - 1)) * CHART_W;
  const y = (v: number) => CHART_H - (v / peak) * (CHART_H - 8);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.watching).toFixed(1)}`).join(" ");
  const area = `${line} L${CHART_W},${CHART_H} L0,${CHART_H} Z`;
  const shown = active === null ? null : points[active];
  const leftPct = active === null ? 0 : (active / (points.length - 1)) * 100;

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    setActive(Math.round(frac * (points.length - 1)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" ? -1 : 1;
    setActive((i) => Math.min(points.length - 1, Math.max(0, (i ?? (step > 0 ? -1 : points.length)) + step)));
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Peak: <span className="font-medium text-foreground tabular-nums">{peakPoint?.watching ?? 0}</span> watching
        {peakPoint ? ` at ${clock.format(new Date(peakPoint.at))}` : ""} ({timezone})
      </p>
      <div className="flex gap-2">
        <div className="flex h-40 flex-col justify-between py-0.5 text-right text-[11px] tabular-nums text-muted-foreground">
          <span>{peak}</span>
          <span>{Math.round(peak / 2)}</span>
          <span>0</span>
        </div>
        <div
          className="relative h-40 flex-1 cursor-crosshair rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="img"
          aria-label={`People watching each minute, peak ${peakPoint?.watching ?? 0}. Use the left and right arrow keys to read a minute.`}
          tabIndex={0}
          onPointerMove={pick}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
        >
          <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible">
            {[0, 0.5, 1].map((f) => (
              <line
                key={f}
                x1={0}
                x2={CHART_W}
                y1={CHART_H - f * (CHART_H - 8)}
                y2={CHART_H - f * (CHART_H - 8)}
                className="stroke-border"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path d={area} className="fill-primary/15" />
            <path
              d={line}
              className="fill-none stroke-primary"
              strokeWidth={2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {shown ? (
            <>
              <div className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${leftPct}%` }} />
              <div
                className="pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs shadow-sm"
                style={leftPct > 70 ? { right: `${100 - leftPct}%`, marginRight: 8 } : { left: `${leftPct}%`, marginLeft: 8 }}
              >
                <div className="font-semibold tabular-nums text-foreground">{shown.watching} watching</div>
                <div className="text-muted-foreground">{clock.format(new Date(shown.at))}</div>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex justify-between pl-8 text-[11px] tabular-nums text-muted-foreground">
        <span>{clock.format(new Date(points[0].at))}</span>
        <span>{clock.format(new Date(points[Math.floor((points.length - 1) / 2)].at))}</span>
        <span>{clock.format(new Date(points[points.length - 1].at))}</span>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">Show the numbers</summary>
        <div className="mt-2 max-h-56 overflow-y-auto rounded border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Minute ({timezone})</th>
                <th className="px-3 py-1.5 text-right font-medium">Watching</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {points.map((p) => (
                <tr key={p.at}>
                  <td className="px-3 py-1">{clock.format(new Date(p.at))}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{p.watching}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
