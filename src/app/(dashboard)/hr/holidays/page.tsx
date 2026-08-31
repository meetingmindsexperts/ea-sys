"use client";

/**
 * /hr/holidays — the org's public holidays, by year.
 *
 * A holiday is a fact the whole module computes from: a rule-based AL block
 * charges it, a WFH company day skips it, a dragged range of sick leave stops
 * at it. So it is entered by hand and dated exactly, never generated. Islamic
 * dates move with the moon; HR enters each year's once announced. The Gregorian
 * ones are seeded. Until this screen existed the only way to add or correct a
 * holiday was SQL (review M8).
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateHrHoliday, useDeleteHrHoliday, useHrHolidays } from "@/hr/hooks/use-hr-api";
import { CalendarClock, CalendarDays, Flag, Loader2, Trash2, TriangleAlert, Users } from "lucide-react";

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function weekdayOf(date: string): string {
  return WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export default function HrHolidaysPage() {
  const { data, isLoading, isError, error } = useHrHolidays();
  const create = useCreateHrHoliday();
  const remove = useDeleteHrHoliday();
  const [form, setForm] = useState({ date: "", label: "" });

  const byYear = useMemo(() => {
    const groups = new Map<string, { id: string; date: string; label: string }[]>();
    for (const h of data ?? []) {
      const year = h.date.slice(0, 4);
      groups.set(year, [...(groups.get(year) ?? []), h]);
    }
    return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [data]);

  async function add() {
    if (!form.date || !form.label.trim()) return;
    try {
      await create.mutateAsync({ date: form.date, label: form.label.trim() });
      toast.success(`${form.label.trim()} added on ${form.date}.`);
      setForm({ date: "", label: "" });
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function del(h: { id: string; date: string; label: string }) {
    if (!window.confirm(`Remove ${h.label} on ${h.date}? Every range and rule over that date is re-costed as a working day.`)) return;
    try {
      await remove.mutateAsync(h.id);
      toast.success(`${h.label} removed.`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (isLoading) {
    return (
      <div className="mt-20 flex items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading holidays…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="mx-auto mt-20 max-w-md rounded-lg border border-amber-300 bg-amber-50 p-6 text-center">
        <TriangleAlert className="mx-auto mb-3 h-8 w-8 text-amber-700" />
        <h2 className="font-semibold text-amber-900">Couldn&apos;t load holidays</h2>
        <p className="mt-2 text-sm text-amber-800">{(error as Error)?.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Flag className="h-6 w-6 text-primary" />
            Public holidays
          </h1>
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
            Entered by hand and dated exactly. Islamic dates are added each year once announced;
            the fixed ones are seeded. A holiday is not a working day, so annual leave across it is
            still charged and a company WFH day skips it.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="secondary">
            <Link href="/hr"><CalendarClock className="h-4 w-4" /> Leave summary</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/hr/attendance"><CalendarDays className="h-4 w-4" /> Attendance</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/hr/employees"><Users className="h-4 w-4" /> Employees</Link>
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-wider text-primary">
          Add a holiday
        </h2>
        <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-1">
            <Label className="text-xs">Date</Label>
            <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Name</Label>
            <Input value={form.label} placeholder="Eid al-Fitr"
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
          </div>
          <Button disabled={create.isPending || !form.date || !form.label.trim()} onClick={() => void add()}>
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Add
          </Button>
        </div>
      </div>

      {byYear.length === 0 ? (
        <p className="rounded-lg border px-3 py-10 text-center text-sm text-muted-foreground">
          No holidays yet.
        </p>
      ) : (
        byYear.map(([year, rows]) => (
          <div key={year} className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{year}</th>
                  <th className="px-3 py-2 text-left font-medium">Day</th>
                  <th className="px-3 py-2 text-left font-medium">Holiday</th>
                  <th className="px-3 py-2 text-right font-medium">{rows.length} {rows.length === 1 ? "date" : "dates"}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((h) => (
                  <tr key={h.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2 font-mono tabular-nums">{h.date}</td>
                    <td className="px-3 py-2 text-muted-foreground">{weekdayOf(h.date)}</td>
                    <td className="px-3 py-2">{h.label}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        className="rounded p-1 text-muted-foreground/60 hover:text-destructive"
                        title="Remove this holiday"
                        disabled={remove.isPending}
                        onClick={() => void del(h)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      <p className="text-xs text-muted-foreground">
        A holiday cannot be removed while attendance is recorded on that date; clear or re-code
        those days first. Adding and removing are both recorded in the activity log.
      </p>
    </div>
  );
}
