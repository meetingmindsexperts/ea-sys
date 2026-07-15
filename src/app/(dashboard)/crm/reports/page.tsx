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
import { Download, Loader2, TrendingUp, Trophy, Users, X } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OwnerFilter } from "@/crm/components/filters/owner-filter";
import { DateRangeFilter } from "@/crm/components/filters/date-range-filter";
import { useCrmEvents, useCrmReport } from "@/crm/hooks/use-crm-api";
import { useCrmFilters } from "@/crm/lib/use-crm-filters";
import { canViewDealValues } from "@/crm/lib/crm-roles";
import { formatDealValue } from "@/crm/lib/crm-types";

const ALL_EVENTS = "__all__";
const REPORT_FILTER_KEYS = ["event", "owner", "dateField", "from", "to"];
const DATE_FIELDS = [
  { value: "expectedClose", label: "Expected close" },
  { value: "createdAt", label: "Created" },
  { value: "closed", label: "Closed (won/lost)" },
];

function money(v: number | null): string {
  // A redacted value and a zero are different facts.
  return v === null ? "—" : formatDealValue(v, "USD") ?? "—";
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

  const { data: report, isLoading } = useCrmReport(filters);
  const { data: events = [] } = useCrmEvents();
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
        <Select value={get("event") || ALL_EVENTS} onValueChange={(v) => set({ event: v === ALL_EVENTS ? null : v })}>
          <SelectTrigger className="w-[14rem]">
            <SelectValue placeholder="All events" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_EVENTS}>All events</SelectItem>
            {events.map((e: { id: string; name: string }) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <OwnerFilter value={get("owner")} onChange={(v) => set({ owner: v })} />
        <DateRangeFilter
          fields={DATE_FIELDS}
          fieldValue={get("dateField") || "expectedClose"}
          onFieldChange={(v) => set({ dateField: v === "expectedClose" ? null : v })}
          from={get("from")}
          to={get("to")}
          onFromChange={(v) => set({ from: v })}
          onToChange={(v) => set({ to: v })}
        />
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={() => clear(REPORT_FILTER_KEYS)}>
            <X className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>

      {isLoading || !report ? (
        <div className="flex items-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Building the report…
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* ── Pipeline by stage ──────────────────────────────────────────── */}
          <section className="rounded-lg border">
            <header className="flex items-center gap-2 border-b p-3">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Pipeline by stage</h2>
              <span className="ml-auto text-xs text-muted-foreground">
                {report.pipeline.openCount} open · {money(report.pipeline.openValue)}
              </span>
            </header>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Deals</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.pipeline.stages.map((s) => (
                  <TableRow key={s.stageId}>
                    <TableCell className="font-medium">
                      {s.stageName}
                      {s.isTerminal && (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          closed
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{s.count}</TableCell>
                    <TableCell className="text-right">{money(s.value)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          {/* ── Win / loss ─────────────────────────────────────────────────── */}
          <section className="rounded-lg border">
            <header className="flex items-center gap-2 border-b p-3">
              <Trophy className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Win / loss</h2>
              <span className="ml-auto text-xs text-muted-foreground">
                {report.winLoss.winRate === null ? "no closed deals" : `${report.winLoss.winRate}% win rate`}
              </span>
            </header>
            <div className="grid grid-cols-2 gap-px bg-border">
              <Stat label="Won" count={report.winLoss.wonCount} value={money(report.winLoss.wonValue)} tone="win" />
              <Stat label="Lost" count={report.winLoss.lostCount} value={money(report.winLoss.lostValue)} tone="loss" />
            </div>
          </section>

          {/* ── By rep ─────────────────────────────────────────────────────── */}
          <section className="rounded-lg border lg:col-span-2">
            <header className="flex items-center gap-2 border-b p-3">
              <Users className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">By sales rep</h2>
            </header>
            {report.reps.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No deals match these filters.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
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
                      <TableCell className="text-right">{r.openCount}</TableCell>
                      <TableCell className="text-right">{money(r.openValue)}</TableCell>
                      <TableCell className="text-right">{r.wonCount}</TableCell>
                      <TableCell className="text-right font-medium">{money(r.wonValue)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </div>
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
      <p className="mt-1 text-2xl font-bold">{count}</p>
      <p className="text-sm text-muted-foreground">{value}</p>
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
