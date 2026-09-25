"use client";

/**
 * The pieces both traffic views draw with (Sep 25, 2026): the per-event
 * "Public page traffic" card and the app-wide Analytics page. One set, so the
 * two cannot drift into showing the same number two ways.
 */

import { Button } from "@/components/ui/button";
import { TrendingDown } from "lucide-react";

export const TRAFFIC_RANGES = [7, 30, 90, 365] as const;

export interface FunnelStepView {
  name: string;
  label: string;
  count: number;
  conversionRate: number;
  dropOff: number;
  dropOffRate: number;
}

export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function duration(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function RangePicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Time range">
      {TRAFFIC_RANGES.map((r) => (
        <Button
          key={r}
          size="sm"
          variant={days === r ? "default" : "outline"}
          className="h-7 px-2 text-xs"
          onClick={() => onChange(r)}
          aria-pressed={days === r}
        >
          {r === 365 ? "1y" : `${r}d`}
        </Button>
      ))}
    </div>
  );
}

export function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" }) {
  return (
    <div className="rounded-md border bg-slate-50/60 p-3">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${tone === "warn" ? "text-amber-600" : "text-slate-900"}`}>{value}</p>
      {hint && <p className="text-[10px] text-slate-500">{hint}</p>}
    </div>
  );
}

/** `title={null}` when the surrounding card already names the funnel. */
export function FunnelBars({ steps, note, title = "Registration funnel" }: { steps: FunnelStepView[]; note?: React.ReactNode; title?: string | null }) {
  const top = steps[0]?.count ?? 0;
  if (steps.length === 0 || top === 0) return null;
  return (
    <div>
      {title && (
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-700">
          <TrendingDown className="h-3.5 w-3.5" /> {title}
        </p>
      )}
      <div className="space-y-2">
        {steps.map((step, i) => (
          <div key={step.name}>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-slate-700">{step.label}</span>
              <span className="tabular-nums font-medium text-slate-900">
                {step.count.toLocaleString()}
                <span className="ml-2 text-xs font-normal text-slate-500">{pct(step.conversionRate)}</span>
              </span>
            </div>
            <div className="mt-1 h-3 overflow-hidden rounded bg-slate-100">
              <div className="h-full rounded bg-primary/70" style={{ width: `${Math.min(100, (step.count / top) * 100)}%` }} />
            </div>
            {i > 0 && step.dropOff > 0 && (
              <p className="mt-0.5 text-[11px] text-slate-500">
                {step.dropOff.toLocaleString()} left here ({pct(step.dropOffRate)})
              </p>
            )}
          </div>
        ))}
      </div>
      {note && <p className="mt-2 text-[11px] text-slate-500">{note}</p>}
    </div>
  );
}

/** Pageviews per day as columns, with the first date, the peak and "today" underneath. */
export function DailyBars({ daily, height = "h-20" }: { daily: { date: string; pageviews: number; visitors: number }[]; height?: string }) {
  const peak = Math.max(1, ...daily.map((d) => d.pageviews));
  return (
    <div>
      <div className={`flex ${height} items-end gap-[2px]`}>
        {daily.map((d) => (
          <div key={d.date} className="flex h-full flex-1 flex-col justify-end" title={`${d.date}: ${d.pageviews} views, ${d.visitors} visitors`}>
            {d.pageviews === 0 ? (
              <div className="h-[2px] w-full rounded-sm bg-slate-100" />
            ) : (
              <div className="w-full rounded-t-sm bg-primary/60" style={{ height: `${Math.max(3, (d.pageviews / peak) * 100)}%` }} />
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
        <span>{daily[0]?.date}</span>
        <span>views per day · peak {peak.toLocaleString()}</span>
        <span>today</span>
      </div>
    </div>
  );
}

/** A tiny trend for a table row: no axes, just the shape. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const peak = Math.max(1, ...values);
  return (
    <div className="flex h-6 w-36 items-end gap-px" role="img" aria-label={label}>
      {values.map((v, i) => (
        <div key={i} className="flex h-full flex-1 flex-col justify-end">
          <div className={v === 0 ? "h-px w-full bg-slate-200" : "w-full bg-primary/60"} style={v === 0 ? undefined : { height: `${Math.max(8, (v / peak) * 100)}%` }} />
        </div>
      ))}
    </div>
  );
}

export function TopList({
  title,
  rows,
  empty,
  icon,
  limit = 6,
}: {
  title: string;
  rows: { label: string; n: number }[];
  empty: string;
  icon?: React.ReactNode;
  limit?: number;
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
          {rows.slice(0, limit).map((r) => (
            <li key={r.label} className="relative text-xs">
              <div className="absolute inset-y-0 left-0 rounded-sm bg-primary/10" style={{ width: `${(r.n / max) * 100}%` }} />
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

/** The honest-counting note both views end with. */
export function PrivacyNote({ timeZone, truncated, hitsRead, extra }: { timeZone: string; truncated: boolean; hitsRead: number; extra?: string }) {
  return (
    <p className="border-t pt-3 text-[11px] leading-relaxed text-slate-500">
      Visitors are counted without cookies and cannot be identified or followed between days. Bots and link previews are
      excluded, so these numbers are lower, and more honest, than raw server hits. Days are grouped in {timeZone}.
      {extra ? ` ${extra}` : ""}
      {truncated && ` Only the first ${hitsRead.toLocaleString()} hits in this range were counted.`}
    </p>
  );
}

/** "Online registrations are counted from 20 Aug 2026, when visit measurement began." */
export function measuredFromText(measuredFrom: string | null, rangeFrom: string): string | null {
  if (!measuredFrom || new Date(measuredFrom) <= new Date(rangeFrom)) return null;
  const d = new Date(measuredFrom).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return `Online registrations are counted from ${d}, when visit measurement began, so earlier sign-ups are not set against visits that were never recorded.`;
}
