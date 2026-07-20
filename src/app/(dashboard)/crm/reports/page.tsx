"use client";

/**
 * CRM Reports — pipeline, win/loss, and a per-rep leaderboard, plus CSV export.
 *
 * The report honours the same filters as the board (URL-backed), so "the report"
 * always means "a report of what I'm filtered to". Money is finance-gated end to
 * end: a MEMBER sees counts + win-rate, values render "—" (never a fabricated 0),
 * and the CSV export drops the value columns entirely — the SERVER enforces both.
 */
import { Suspense } from "react";
import { useSession } from "next-auth/react";
import { Download, Layers, Percent, TrendingUp, Trophy, Users, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EventCombobox } from "@/crm/components/event-combobox";
import { OwnerFilter } from "@/crm/components/filters/owner-filter";
import { DateRangeFilter } from "@/crm/components/filters/date-range-filter";
import { useCrmReport } from "@/crm/hooks/use-crm-api";
import { CrmLoadError } from "@/crm/components/crm-load-error";
import { useCrmFilters } from "@/crm/lib/use-crm-filters";
import { canViewDealValues } from "@/crm/lib/crm-roles";
import { formatDealValue } from "@/crm/lib/crm-types";

const REPORT_FILTER_KEYS = ["event", "owner", "dateField", "from", "to"];
const DATE_FIELDS = [
  { value: "expectedClose", label: "Expected close" },
  { value: "createdAt", label: "Created" },
  { value: "closed", label: "Closed (won/lost)" },
];

function money(v: number | null, currency: string | null, mixed?: boolean): string {
  // Mixed-currency buckets are called out, never summed into a fake number (H2),
  // and a redacted value and a zero stay different facts.
  if (mixed) return "— (mixed currencies)";
  return v === null ? "—" : formatDealValue(v, currency ?? "USD") ?? "—";
}

function ReportsInner() {
  const { data: session } = useSession();
  const canSeeValues = canViewDealValues(session?.user?.role);

  const { get, set, clear, anyActive } = useCrmFilters();
  const filters = {
    eventId: get("event") || undefined,
    ownerId: get("owner") || undefined,
    dateField: get("dateField") || undefined,
    from: get("from") || undefined,
    to: get("to") || undefined,
  };

  const { data: report, isLoading, isError, refetch } = useCrmReport(filters);
  const filtersActive = anyActive(REPORT_FILTER_KEYS);

  // The export honours the current URL filters — same params, plus status.
  const exportHref = (() => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({
      event: get("event"),
      owner: get("owner"),
      status: get("status"),
      dateField: get("dateField"),
      from: get("from"),
      to: get("to"),
      min: get("min"),
      max: get("max"),
    })) {
      if (v) qs.set(k === "event" ? "eventId" : k === "owner" ? "ownerId" : k, v);
    }
    const s = qs.toString();
    return `/api/crm/deals/export${s ? `?${s}` : ""}`;
  })();

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Pipeline, win rate and rep performance — of whatever you filter to.
        </p>
        <Button asChild variant="outline">
          {/* A plain link so the browser downloads it; honours current filters. */}
          <a href={exportHref} download>
            <Download className="mr-2 h-4 w-4" />
            Export deals (CSV)
          </a>
        </Button>
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2">
        <EventCombobox
          value={get("event") || null}
          onChange={(v) => set({ event: v })}
          clearLabel="All events"
          className="w-[14rem]"
        />
        <OwnerFilter value={get("owner")} onChange={(v) => set({ owner: v })} />
        <DateRangeFilter
          fields={DATE_FIELDS}
          fieldValue={get("dateField") || "expectedClose"}
          onFieldChange={(v) => set({ dateField: v === "expectedClose" ? null : v })}
          from={get("from")}
          to={get("to")}
          onApply={({ from, to }) => set({ from, to })}
        />
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={() => clear(REPORT_FILTER_KEYS)}>
            <X className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>

      {isError ? (
        <CrmLoadError what="the report" onRetry={() => refetch()} />
      ) : isLoading || !report ? (
        <ReportSkeleton />
      ) : (
        <>
          {/* ── KPI strip ────────────────────────────────────────────────────── */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard icon={Layers} label="Open deals" value={String(report.pipeline.openCount)} />
            <KpiCard icon={TrendingUp} label="Open value" value={money(report.pipeline.openValue, report.pipeline.openCurrency, report.pipeline.openMixed)} />
            <KpiCard icon={Trophy} label="Won" value={String(report.winLoss.wonCount)} sub={money(report.winLoss.wonValue, report.winLoss.wonCurrency ?? null, report.winLoss.wonMixed)} tone="win" />
            <KpiCard
              icon={Percent}
              label="Win rate"
              value={report.winLoss.winRate === null ? "—" : `${report.winLoss.winRate}%`}
              sub={`${report.winLoss.wonCount} won · ${report.winLoss.lostCount} lost`}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
          {/* ── Pipeline by stage ──────────────────────────────────────────── */}
          <section className="overflow-hidden rounded-xl border bg-card">
            <header className="flex items-center gap-2 border-b p-3">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Pipeline by stage</h2>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                {report.pipeline.openCount} open · {money(report.pipeline.openValue, report.pipeline.openCurrency, report.pipeline.openMixed)}
              </span>
            </header>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Deals</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(() => {
                  const maxCount = Math.max(1, ...report.pipeline.stages.map((s) => s.count));
                  return report.pipeline.stages.map((s) => (
                    <TableRow key={s.stageId}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <span>{s.stageName}</span>
                          {s.isTerminal && (
                            <Badge variant="outline" className="text-[10px]">
                              closed
                            </Badge>
                          )}
                        </div>
                        {/* Proportion of deals in this stage — read the funnel at a glance. */}
                        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary/40"
                            style={{ width: `${(s.count / maxCount) * 100}%` }}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{s.count}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(s.value, s.currency, s.mixed)}</TableCell>
                    </TableRow>
                  ));
                })()}
              </TableBody>
            </Table>
          </section>

          {/* ── Win / loss ─────────────────────────────────────────────────── */}
          <section className="overflow-hidden rounded-xl border bg-card">
            <header className="flex items-center gap-2 border-b p-3">
              <Trophy className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Win / loss</h2>
              <span className="ml-auto text-xs text-muted-foreground">
                {report.winLoss.winRate === null ? "no closed deals" : `${report.winLoss.winRate}% win rate`}
              </span>
            </header>
            <div className="grid grid-cols-2 gap-px bg-border">
              <Stat label="Won" count={report.winLoss.wonCount} value={money(report.winLoss.wonValue, report.winLoss.wonCurrency ?? null, report.winLoss.wonMixed)} tone="win" />
              <Stat label="Lost" count={report.winLoss.lostCount} value={money(report.winLoss.lostValue, report.winLoss.lostCurrency ?? null, report.winLoss.lostMixed)} tone="loss" />
            </div>
          </section>

          {/* ── By rep ─────────────────────────────────────────────────────── */}
          <section className="overflow-hidden rounded-xl border bg-card lg:col-span-2">
            <header className="flex items-center gap-2 border-b p-3">
              <Users className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">By sales rep</h2>
            </header>
            {report.reps.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No deals match these filters.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>Rep</TableHead>
                    <TableHead className="text-right">Open</TableHead>
                    <TableHead className="text-right">Open value</TableHead>
                    <TableHead className="text-right">Won</TableHead>
                    <TableHead className="text-right">Won value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.reps.map((r) => (
                    <TableRow key={r.ownerId ?? "none"}>
                      <TableCell className="font-medium">{r.ownerName}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.openCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.openValue, r.openCurrency, r.openMixed)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.wonCount}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{money(r.wonValue, r.wonCurrency, r.wonMixed)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
          </div>
        </>
      )}

      {report && !canSeeValues && (
        <p className="text-xs text-muted-foreground">
          Deal values are hidden for your role — counts and win rate are shown. The CSV export omits value columns.
        </p>
      )}
    </div>
  );
}

function Stat({ label, count, value, tone }: { label: string; count: number; value: string; tone: "win" | "loss" }) {
  return (
    <div className="bg-background p-4">
      <p className={`text-xs font-medium ${tone === "win" ? "text-emerald-600" : "text-rose-600"}`}>{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{count}</p>
      <p className="text-sm text-muted-foreground tabular-nums">{value}</p>
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  tone?: "win";
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <p className={cn("mt-2 text-2xl font-bold tabular-nums", tone === "win" && "text-emerald-600")}>{value}</p>
      {sub && <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{sub}</p>}
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2 rounded-xl border p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-16" />
          </div>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-xl border p-4">
            <Skeleton className="h-4 w-32" />
            {Array.from({ length: 4 }).map((_, r) => (
              <Skeleton key={r} className="h-4 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CrmReportsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <ReportsInner />
    </Suspense>
  );
}
