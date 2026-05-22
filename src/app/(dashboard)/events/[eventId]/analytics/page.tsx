"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Download, Users, ScanBarcode, IdCard, DollarSign, Clock } from "lucide-react";
import type { EventAnalytics } from "@/lib/event-analytics";

const STATUS_COLORS: Record<string, string> = {
  CONFIRMED: "bg-emerald-500",
  PENDING: "bg-amber-500",
  CHECKED_IN: "bg-violet-500",
  CANCELLED: "bg-slate-400",
  WAITLISTED: "bg-sky-500",
};

/** Horizontal bar row — label, value, proportional fill. */
function Bar({ label, count, max, color = "bg-primary" }: { label: string; count: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-700 truncate pr-2">{label}</span>
        <span className="font-medium text-slate-900 tabular-nums">{count.toLocaleString()}</span>
      </div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold uppercase tracking-wide text-slate-700">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

function Kpi({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-slate-500 text-sm mb-2">
          {icon}
          <span>{label}</span>
        </div>
        <div className="text-2xl font-bold text-slate-900">{value}</div>
        {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

export default function EventAnalyticsPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  const { data, isLoading, isError } = useQuery<EventAnalytics>({
    queryKey: ["event-analytics", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/analytics`);
      if (!res.ok) throw new Error("Failed to load analytics");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (isError || !data) {
    return <div className="py-24 text-center text-slate-500">Couldn&apos;t load analytics. Please retry.</div>;
  }

  const a = data;
  const regMax = Math.max(1, ...a.registrations.byType.map((b) => b.count), ...a.registrations.byTier.map((b) => b.count));
  const regDayMax = Math.max(1, ...a.registrations.overTime.map((b) => b.count));
  const hourMax = Math.max(1, ...a.checkIn.byHour.map((b) => b.count));
  const staffMax = Math.max(1, ...a.checkIn.byStaff.map((b) => b.count));
  const statusMax = Math.max(1, ...Object.values(a.registrations.byStatus));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Analytics</h1>
          <p className="text-sm text-slate-500">
            Operational metrics for {a.event.name}. Times in {a.event.timezone}.
          </p>
        </div>
        <Button variant="outline" asChild>
          <a href={`/api/events/${eventId}/analytics?export=csv`} download>
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </a>
        </Button>
      </div>

      {/* Headline KPIs */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Kpi icon={<Users className="h-4 w-4" />} label="Registrations" value={a.registrations.total.toLocaleString()} sub={`${a.checkIn.eligible.toLocaleString()} active (not cancelled)`} />
        <Kpi icon={<ScanBarcode className="h-4 w-4" />} label="Checked in" value={`${a.checkIn.checkedIn.toLocaleString()} (${a.checkIn.rate}%)`} sub={`${a.checkIn.notCheckedIn.toLocaleString()} not yet checked in`} />
        <Kpi icon={<IdCard className="h-4 w-4" />} label="Badges printed" value={a.badges.printed.toLocaleString()} sub={`${a.badges.reprints.toLocaleString()} reprints · ${a.badges.notPrinted.toLocaleString()} not printed`} />
        {a.revenue ? (
          <Kpi
            icon={<DollarSign className="h-4 w-4" />}
            label="Revenue collected"
            value={a.revenue.collected.length ? a.revenue.collected.map((c) => `${c.currency} ${c.amount.toLocaleString()}`).join(" · ") : "—"}
            sub={`${a.revenue.outstandingCount.toLocaleString()} outstanding`}
          />
        ) : (
          <Kpi icon={<Clock className="h-4 w-4" />} label="Peak check-in" value={a.checkIn.peakHour ? `${String(a.checkIn.peakHour.hour).padStart(2, "0")}:00` : "—"} sub={a.checkIn.peakHour ? `${a.checkIn.peakHour.count} in that hour` : undefined} />
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Registrations by status">
          {Object.entries(a.registrations.byStatus).sort((x, y) => y[1] - x[1]).map(([status, count]) => (
            <Bar key={status} label={status} count={count} max={statusMax} color={STATUS_COLORS[status] ?? "bg-primary"} />
          ))}
        </Section>

        <Section title="Registrations by type">
          {a.registrations.byType.length ? a.registrations.byType.map((b) => (
            <Bar key={b.label} label={b.label} count={b.count} max={regMax} />
          )) : <p className="text-sm text-slate-400">No data.</p>}
        </Section>

        {a.registrations.byTier.length > 0 && (
          <Section title="Registrations by pricing tier">
            {a.registrations.byTier.map((b) => <Bar key={b.label} label={b.label} count={b.count} max={regMax} color="bg-amber-500" />)}
          </Section>
        )}

        <Section title="Registrations per day">
          {a.registrations.overTime.length ? a.registrations.overTime.map((b) => (
            <Bar key={b.date} label={b.date} count={b.count} max={regDayMax} color="bg-sky-500" />
          )) : <p className="text-sm text-slate-400">No data.</p>}
        </Section>

        <Section title="Check-ins by hour of day">
          {a.checkIn.byHour.length ? a.checkIn.byHour.map((b) => (
            <Bar key={b.hour} label={`${String(b.hour).padStart(2, "0")}:00`} count={b.count} max={hourMax} color="bg-violet-500" />
          )) : <p className="text-sm text-slate-400">No check-ins recorded yet.</p>}
        </Section>

        <Section title="Check-ins by staff">
          {a.checkIn.byStaff.length ? a.checkIn.byStaff.map((b) => (
            <Bar key={b.label} label={b.label} count={b.count} max={staffMax} color="bg-emerald-500" />
          )) : <p className="text-sm text-slate-400">No check-ins recorded yet.</p>}
        </Section>

        <Section title="Badges">
          <Bar label="Printed" count={a.badges.printed} max={Math.max(1, a.checkIn.eligible)} color="bg-primary" />
          <Bar label="Not printed" count={a.badges.notPrinted} max={Math.max(1, a.checkIn.eligible)} color="bg-slate-400" />
          <div className="pt-1 text-xs text-slate-500">
            {a.badges.totalPrints.toLocaleString()} total prints incl. {a.badges.reprints.toLocaleString()} reprints.
          </div>
        </Section>

        {a.revenue && (
          <Section title="Registrations by payment status">
            {Object.entries(a.revenue.byPaymentStatus).sort((x, y) => y[1] - x[1]).map(([status, count]) => (
              <Bar key={status} label={status} count={count} max={Math.max(1, ...Object.values(a.revenue!.byPaymentStatus))} color="bg-emerald-500" />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}
