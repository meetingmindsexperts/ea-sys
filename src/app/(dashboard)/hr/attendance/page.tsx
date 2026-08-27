"use client";

/**
 * /hr/attendance — the month grid: employees down, days across.
 *
 * Only the entries that EXIST come down the wire. Every other cell is DERIVED
 * here with the same precedence the balance engine uses (outside employment,
 * then an explicit entry, then public holiday, then weekend, then present), from
 * the same holiday list the server sends alongside. Two derivations of the same
 * thing would eventually disagree, and the one people look at is not the one
 * that pays anybody.
 *
 * Derived cells are drawn faintly. That is not decoration: a derived P means
 * "nobody wrote anything down", which is usually but not always "they were
 * here", and the grid should not present an inference as a record.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  useHrAttendance,
  useHrEmployees,
  useHrLeaveCodes,
  useSetHrAttendance,
  useClearHrAttendance,
} from "@/hr/hooks/use-hr-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, Loader2, TableProperties, Trash2 } from "lucide-react";

const MS_DAY = 86_400_000;
function iso(d: Date) { return d.toISOString().slice(0, 10); }
function monthBounds(year: number, month: number) {
  return {
    from: iso(new Date(Date.UTC(year, month, 1))),
    to: iso(new Date(Date.UTC(year, month + 1, 0))),
  };
}
function eachDay(from: string, to: string) {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += MS_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Muted for derived cells, saturated for recorded ones. */
const CODE_STYLE: Record<string, string> = {
  AL: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  "AL-HD": "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  "SL-F": "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  "SL-HD": "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  "SL-H": "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  "SL-U": "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  OD: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  CO: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  WFH: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  ABS: "bg-red-200 text-red-900 dark:bg-red-900 dark:text-red-100",
};
const DERIVED_STYLE = "text-muted-foreground/50";

export default function HrAttendancePage() {
  const today = new Date();
  const [year, setYear] = useState(today.getUTCFullYear());
  const [month, setMonth] = useState(today.getUTCMonth());
  const { from, to } = useMemo(() => monthBounds(year, month), [year, month]);
  const days = useMemo(() => eachDay(from, to), [from, to]);

  const { data: employees = [], isLoading: loadingEmployees } = useHrEmployees();
  const { data: codes = [] } = useHrLeaveCodes();
  const { data, isLoading, isError, error } = useHrAttendance(from, to);
  const setAttendance = useSetHrAttendance();
  const clearAttendance = useClearHrAttendance();

  const [form, setForm] = useState({ employeeId: "", from: "", to: "", code: "AL" });

  const entryAt = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of data?.entries ?? []) m.set(`${e.employeeId}|${e.date}`, e.code);
    return m;
  }, [data]);
  const holidays = useMemo(
    () => new Map((data?.holidays ?? []).map((h) => [h.date, h.label])),
    [data],
  );

  function cellFor(employee: (typeof employees)[number], date: string) {
    if (date < employee.joiningDate) return { code: "", derived: true, title: "before joining" };
    if (employee.exitDate && date > employee.exitDate) return { code: "", derived: true, title: "after leaving" };
    const recorded = entryAt.get(`${employee.id}|${date}`);
    if (recorded) return { code: recorded, derived: false, title: recorded };
    const holiday = holidays.get(date);
    if (holiday) return { code: "PH", derived: true, title: holiday };
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) return { code: "OFF", derived: true, title: "weekend" };
    return { code: "P", derived: true, title: "present (derived)" };
  }

  async function submit() {
    if (!form.employeeId || !form.from) {
      toast.error("Pick a person and a start date.");
      return;
    }
    try {
      const res = await setAttendance.mutateAsync({
        employeeId: form.employeeId,
        from: form.from,
        to: form.to || undefined,
        code: form.code,
      });
      toast.success(
        `Recorded ${res.written} day${res.written === 1 ? "" : "s"}` +
          (res.skipped.length ? `, skipped ${res.skipped.length} non-working day(s)` : ""),
      );
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function clear() {
    if (!form.employeeId || !form.from) {
      toast.error("Pick a person and a start date.");
      return;
    }
    try {
      const res = await clearAttendance.mutateAsync({
        employeeId: form.employeeId,
        from: form.from,
        to: form.to || undefined,
      });
      toast.success(`Cleared ${res.removed} entr${res.removed === 1 ? "y" : "ies"}.`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (isError) {
    return (
      <div className="mx-auto mt-20 max-w-md rounded-lg border border-amber-300 bg-amber-50 p-6 text-center">
        <h2 className="font-semibold text-amber-900">Couldn&apos;t load attendance</h2>
        <p className="mt-2 text-sm text-amber-800">{(error as Error)?.message}</p>
      </div>
    );
  }

  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleString("en-GB", {
    month: "long", year: "numeric", timeZone: "UTC",
  });

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <TableProperties className="h-6 w-6 text-primary" />
            Attendance
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Faint cells are worked out (weekend, holiday, present); solid cells were recorded.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => {
            const d = new Date(Date.UTC(year, month - 1, 1));
            setYear(d.getUTCFullYear()); setMonth(d.getUTCMonth());
          }}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="w-40 text-center text-sm font-medium">{monthLabel}</span>
          <Button variant="ghost" size="icon" onClick={() => {
            const d = new Date(Date.UTC(year, month + 1, 1));
            setYear(d.getUTCFullYear()); setMonth(d.getUTCMonth());
          }}><ChevronRight className="h-4 w-4" /></Button>
          <Button asChild variant="secondary"><Link href="/hr">Leave summary</Link></Button>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border p-3 md:grid-cols-5">
        <div className="space-y-1">
          <Label className="text-xs">Employee</Label>
          <Select value={form.employeeId} onValueChange={(v) => setForm((f) => ({ ...f, employeeId: v }))}>
            <SelectTrigger><SelectValue placeholder="Pick someone" /></SelectTrigger>
            <SelectContent>
              {employees.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.name} ({e.empCode})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">From</Label>
          <Input type="date" value={form.from} onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">To (optional)</Label>
          <Input type="date" value={form.to} onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Code</Label>
          <Select value={form.code} onValueChange={(v) => setForm((f) => ({ ...f, code: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {codes.map((c) => (
                <SelectItem key={c.id} value={c.code}>{c.code} — {c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end gap-2">
          <Button onClick={submit} disabled={setAttendance.isPending} className="flex-1">
            {setAttendance.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Record
          </Button>
          <Button variant="outline" size="icon" onClick={clear} disabled={clearAttendance.isPending} title="Clear this range">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground md:col-span-5">
          A range covers working days only: weekends and public holidays inside it
          are skipped, so twelve calendar days of annual leave is not charged as twelve days.
        </p>
      </div>

      {isLoading || loadingEmployees ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-muted/50">
                <th className="sticky left-0 z-10 min-w-[180px] bg-muted/50 px-3 py-2 text-left font-medium">
                  Employee
                </th>
                {days.map((d) => {
                  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
                  const weekend = dow === 0 || dow === 6;
                  return (
                    <th
                      key={d}
                      className={`w-8 px-0 py-2 text-center font-normal ${weekend ? "text-muted-foreground/60" : ""}`}
                      title={d}
                    >
                      {Number(d.slice(8, 10))}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y">
              {employees.map((e) => (
                <tr key={e.id} className="hover:bg-muted/20">
                  <td className="sticky left-0 z-10 bg-background px-3 py-1.5">
                    <div className="font-medium">{e.name}</div>
                    <div className="text-[10px] text-muted-foreground">{e.empCode}</div>
                  </td>
                  {days.map((d) => {
                    const c = cellFor(e, d);
                    const style = c.derived ? DERIVED_STYLE : (CODE_STYLE[c.code] ?? "bg-muted");
                    return (
                      <td key={d} className="p-0 text-center" title={`${d} — ${c.title}`}>
                        <div className={`mx-auto my-0.5 flex h-6 w-7 items-center justify-center rounded text-[10px] ${style}`}>
                          {c.code}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={days.length + 1} className="px-3 py-10 text-center text-muted-foreground">
                    No employees yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
