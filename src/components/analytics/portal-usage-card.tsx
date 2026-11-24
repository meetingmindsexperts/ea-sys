"use client";

/**
 * Attendee portal, a card of its own on the Analytics page (Nov 24, 2026):
 * how many registrants, abstract authors and reviewers of your events have
 * an account, how many were active lately, and sign-ins per week. Data from
 * /api/analytics/portal-usage (the rule is src/lib/portal-usage.ts). It keeps
 * its own fixed windows, so the page's range picker does not change it.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, UserRound } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Kpi } from "@/components/analytics/traffic-parts";

interface RoleRow {
  role: "REGISTRANT" | "SUBMITTER" | "REVIEWER";
  accounts: number;
  activeToday: number;
  active7d: number;
  active30d: number;
  everActive: number;
}

interface PortalUsageResponse {
  eventsInScope: number;
  roles: RoleRow[];
  totals: Omit<RoleRow, "role">;
  weekly: { weekStart: string; people: number; signIns: number }[];
  signInsRecordedFrom: string | null;
}

const ROLE_NAME: Record<RoleRow["role"], string> = {
  REGISTRANT: "Registrants",
  SUBMITTER: "Abstract authors",
  REVIEWER: "Reviewers",
};

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function WeeklyBars({ weekly }: { weekly: PortalUsageResponse["weekly"] }) {
  const peak = Math.max(1, ...weekly.map((w) => w.people));
  return (
    <div>
      <div className="flex h-28 items-end gap-2" role="img" aria-label="People signing in per week">
        {weekly.map((w, i) => (
          <div
            key={w.weekStart}
            className="flex h-full flex-1 flex-col items-center justify-end gap-1"
            title={`Week of ${shortDate(w.weekStart)}: ${w.people} people, ${w.signIns} sign-ins${i === weekly.length - 1 ? " (so far)" : ""}`}
          >
            <span className="text-[10px] tabular-nums text-slate-500">{w.people}</span>
            <div
              className={`w-full rounded-t-sm ${i === weekly.length - 1 ? "bg-primary/30" : "bg-primary/60"}`}
              style={{ height: `${w.people === 0 ? 2 : Math.max(4, (w.people / peak) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-2 font-mono text-[10px] text-slate-500">
        {weekly.map((w) => (
          <span key={w.weekStart} className="flex-1 text-center">{shortDate(w.weekStart)}</span>
        ))}
      </div>
      <p className="mt-1 text-[10px] text-slate-500">People signing in each week (Monday start); the lighter bar is the week so far.</p>
    </div>
  );
}

export function PortalUsageCard() {
  const { data, isLoading, isError } = useQuery<PortalUsageResponse>({
    queryKey: ["portal-usage"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/portal-usage");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return res.json();
    },
    staleTime: 60_000,
  });
  const t = data?.totals;
  const recordedFrom = data?.signInsRecordedFrom
    ? new Date(data.signInsRecordedFrom).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
          <UserRound className="h-4 w-4 text-primary" /> Attendee portal
        </CardTitle>
        <p className="text-xs text-slate-500">
          Registrants, abstract authors and reviewers of your events who have an account, and how many use it.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {isError && (
          <p className="flex items-start gap-1.5 text-sm text-amber-600">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Couldn&apos;t load the portal figures. Try again shortly.
          </p>
        )}
        {data && t && t.accounts === 0 && <p className="text-sm text-slate-500">No one linked to your events has an account yet.</p>}
        {data && t && t.accounts > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Accounts" value={t.accounts.toLocaleString()} hint={`${t.everActive.toLocaleString()} have signed in`} />
              <Kpi label="Active today" value={t.activeToday.toLocaleString()} hint="last 24 hours" />
              <Kpi label="Active in 7 days" value={t.active7d.toLocaleString()} />
              <Kpi label="Active in 30 days" value={t.active30d.toLocaleString()} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="overflow-x-auto rounded-md border border-slate-100">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Who</th>
                      <th className="px-3 py-2 text-right font-medium">Accounts</th>
                      <th className="px-3 py-2 text-right font-medium">Today</th>
                      <th className="px-3 py-2 text-right font-medium">7 days</th>
                      <th className="px-3 py-2 text-right font-medium">30 days</th>
                      <th className="px-3 py-2 text-right font-medium">Ever</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.roles.map((r) => (
                      <tr key={r.role}>
                        <td className="px-3 py-2 font-medium text-slate-900">{ROLE_NAME[r.role]}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.accounts.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.activeToday.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.active7d.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.active30d.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.everActive.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <WeeklyBars weekly={data.weekly} />
            </div>

            <p className="text-[11px] text-slate-500">
              Active means signed in and using any of their pages (My account, an event&apos;s own pages, My Reviews) in that
              period. A registration made without an account is not counted, and staff are never counted.
              {recordedFrom ? ` Sign-ins are recorded from ${recordedFrom}.` : ""}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
