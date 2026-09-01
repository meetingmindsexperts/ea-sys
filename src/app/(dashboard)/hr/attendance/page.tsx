"use client";

/**
 * /hr/attendance — the month grid: employees down, days across.
 *
 * THE GRID IS THE INPUT. Select cells and press a key, or pick a code. The
 * previous version displayed 713 cells and accepted input on none of them: to
 * change one you looked away from it and re-described it in a five-field form,
 * which is a translation the machine should be doing.
 *
 * Only the entries that EXIST come down the wire; every other cell is derived,
 * through the SAME `effectiveStatusFor` the balance engine resolves with. It is
 * imported rather than re-implemented on purpose — two derivations of one thing
 * eventually disagree, and the one people look at is not the one that pays
 * anybody.
 *
 * Derived cells are drawn faintly. That is not decoration: a derived P means
 * "nobody wrote anything down", which is usually but not always "they were
 * here", and the grid should not present an inference as a record. A cell a
 * standing RULE produced carries a dot, because "a rule put this here" and
 * "nobody wrote anything down" are different claims.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";
import {
  useCreateHrAttendanceRule,
  useDeleteHrAttendanceRule,
  useHrAttendance,
  useHrEmployees,
  useHrLeaveCodes,
  useSetHrAttendance,
  useClearHrAttendance,
  type HrAttendanceRule,
  type HrEmployee,
  type HrWriteError,
} from "@/hr/hooks/use-hr-api";
import type { LeaveCategory } from "@prisma/client";
import { effectiveStatusFor } from "@/hr/lib/hr-effective-status";
import type { AttendanceRuleLike } from "@/hr/lib/attendance-rules";
import {
  dayOfWeek,
  daysBetween,
  eachDate,
  todayInTimezone,
  type CalendarDate,
} from "@/hr/lib/hr-date";
import { HR_DEFAULT_TIMEZONE, HR_DEFAULT_WEEKEND_DAYS } from "@/hr/lib/hr-constants";
import {
  ARROW_STEP,
  HALF_DAY,
  PRIMARY,
  collapseToHead,
  employedInMonth,
  moveSelection,
  placePopover,
  resolveKeyCode,
  type Selection,
} from "@/hr/lib/attendance-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Building2, CalendarClock, ChevronLeft, ChevronRight, Download, Loader2, TableProperties, Trash2, UserCog,
} from "lucide-react";

const iso = (d: Date) => d.toISOString().slice(0, 10) as CalendarDate;
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * Today, in the org's own week.
 *
 * It used to be `new Date().getUTCFullYear()/getUTCMonth()`. Dubai is UTC+4, so
 * between 00:00 and 03:59 local on the 1st of a month the grid opened on the
 * PREVIOUS month while /hr reported balances "as at" the new one, and the two
 * screens disagreed about what today was. This is exactly what the file's own
 * header argues against: the derivation belongs in `hr-date.ts`, which every
 * other reader already uses.
 */
function todayHere(): CalendarDate {
  return todayInTimezone(HR_DEFAULT_TIMEZONE);
}

function monthBounds(year: number, month: number) {
  return {
    from: iso(new Date(Date.UTC(year, month, 1))),
    to: iso(new Date(Date.UTC(year, month + 1, 0))),
  };
}

/**
 * The DOM cell at a grid coordinate, for focus-scrolling and popover anchoring.
 * Coordinates live on the element (`data-r`/`data-d`) so the keyboard can find
 * a cell it never touched with a pointer.
 */
function cellEl(r: number, d: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-cell][data-r="${r}"][data-d="${d}"]`);
}

/**
 * The code Art. 31 entitles somebody to once the 15 full-pay days are used.
 *
 * Note the naming trap the seed warns about and do not "tidy" it: `SL-H` is
 * half PAY, `SL-HD` is half a DAY. This is the pay tier, not the half day.
 */
const HALF_PAY_SICK_CODE = "SL-H";

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
  PH: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};
const DERIVED_STYLE = "text-muted-foreground/50";

/**
 * One person's write held at the 15-day full-pay sick limit.
 *
 * Kept apart from `failures` on purpose: nothing went wrong. Art. 31 gives 15
 * days at full pay and 30 more at half, and the owner's ruling is that the
 * system says so rather than moving anyone between tiers by itself, because the
 * tier is whichever code is recorded and converting it silently would make the
 * grid disagree with payroll.
 */
interface SickTierAsk {
  employeeId: string;
  name: string;
  from: CalendarDate;
  to: CalendarDate;
  code: string;
  used: number;
  wouldBe: number;
  limit: number;
  leaveYear: number;
}

export default function HrAttendancePage() {
  const [todayIso] = useState(todayHere);
  const [year, setYear] = useState(() => Number(todayIso.slice(0, 4)));
  const [month, setMonth] = useState(() => Number(todayIso.slice(5, 7)) - 1);
  const { from, to } = useMemo(() => monthBounds(year, month), [year, month]);
  const days = useMemo(() => eachDate(from, to), [from, to]);

  // Leavers included, then cut to the people employed at some point in the
  // visible month. A leaver used to vanish the moment the exit was recorded,
  // so notice-period leave could not be entered and a past month could not be
  // corrected, while the "records" tile still counted their rows (review M1).
  const { data: allEmployees = [], isLoading: loadingEmployees } = useHrEmployees(true);
  const employees = useMemo(
    () => allEmployees.filter((e) => employedInMonth(e, from, to)),
    [allEmployees, from, to],
  );
  const { data: codes = [] } = useHrLeaveCodes();
  const { data, isLoading, isError, error } = useHrAttendance(from, to);
  // The grid refetches ONCE after a multi-person write (see apply), so the
  // hooks are told not to invalidate per request.
  const qc = useQueryClient();
  const setAttendance = useSetHrAttendance({ invalidate: false });
  const clearAttendance = useClearHrAttendance({ invalidate: false });
  const createRule = useCreateHrAttendanceRule();
  const deleteRule = useDeleteHrAttendanceRule();

  const [sel, setSel] = useState<Selection | null>(null);
  /** The head cell the code popover is anchored to, as grid coordinates. */
  const [pop, setPop] = useState<{ r: number; d: number } | null>(null);
  const [sickAsks, setSickAsks] = useState<SickTierAsk[] | null>(null);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [standingOpen, setStandingOpen] = useState(false);
  const dragging = useRef(false);
  /* Set synchronously for the whole of one apply(), so a second keypress or a
     double-click on the popover cannot start a second run over the same cells
     while the first is still writing. `isPending` flips too late for that. */
  const applying = useRef(false);
  const busy = setAttendance.isPending || clearAttendance.isPending;

  /* ---------------------------------------------------------- derivation */
  const entriesByEmployee = useMemo(() => {
    const m = new Map<string, Map<CalendarDate, { code: string }>>();
    for (const e of data?.entries ?? []) {
      const inner = m.get(e.employeeId) ?? new Map<CalendarDate, { code: string }>();
      inner.set(e.date as CalendarDate, { code: e.code });
      m.set(e.employeeId, inner);
    }
    return m;
  }, [data]);

  const holidays = useMemo(
    () => new Map((data?.holidays ?? []).map((h) => [h.date as CalendarDate, h.label])),
    [data],
  );
  const holidaySet = useMemo(() => new Set(holidays.keys()), [holidays]);

  const rules = useMemo<HrAttendanceRule[]>(() => data?.rules ?? [], [data]);
  const ruleLikes = useMemo<AttendanceRuleLike[]>(
    () =>
      rules.map((r) => ({
        id: r.id,
        scope: r.scope,
        employeeId: r.employeeId,
        code: r.code,
        // The category decides whether the rule reaches the weekend (annual
        // leave, on-duty, comp-off) or stops at working days; without it the
        // grid would draw an AL shutdown one way and the balance charge it
        // another.
        category: r.category as LeaveCategory,
        startDate: r.startDate as CalendarDate,
        endDate: (r.endDate ?? null) as CalendarDate | null,
      })),
    [rules],
  );
  const ruleById = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules]);

  const EMPTY = useMemo(() => new Map<CalendarDate, { code: string }>(), []);

  function cellFor(employee: HrEmployee, date: CalendarDate) {
    return effectiveStatusFor(date, {
      employment: {
        joiningDate: employee.joiningDate as CalendarDate,
        exitDate: (employee.exitDate ?? null) as CalendarDate | null,
      },
      entriesByDate: entriesByEmployee.get(employee.id) ?? EMPTY,
      holidays: holidaySet,
      rules: ruleLikes,
      employeeId: employee.id,
    });
  }

  /* ------------------------------------------------------------ selection */
  const cellsInSel = useMemo(() => {
    if (!sel) return [] as { employee: HrEmployee; date: CalendarDate }[];
    const r1 = Math.min(sel.r0, sel.r1), r2 = Math.max(sel.r0, sel.r1);
    const d1 = Math.min(sel.d0, sel.d1), d2 = Math.max(sel.d0, sel.d1);
    const out: { employee: HrEmployee; date: CalendarDate }[] = [];
    for (let r = r1; r <= r2 && r < employees.length; r++) {
      for (let d = d1; d <= d2 && d < days.length; d++) {
        const employee = employees[r];
        const date = days[d];
        if (date < employee.joiningDate) continue;
        if (employee.exitDate && date > employee.exitDate) continue;
        out.push({ employee, date });
      }
    }
    return out;
  }, [sel, employees, days]);

  const selectedKeys = useMemo(
    () => new Set(cellsInSel.map((c) => `${c.employee.id}|${c.date}`)),
    [cellsInSel],
  );

  /**
   * A selection spanning several people is written one request per person,
   * because the API records a contiguous range for ONE employee. Two people is
   * two requests; the alternative is a bulk endpoint whose failure semantics
   * would be "some of it worked", which is worse than being slightly chattier.
   */
  /**
   * Answer the 15-day question for everyone it was raised about.
   *
   * "half-pay" records SL-H, which is what Art. 31 entitles them to past 15
   * days. "anyway" re-sends the original code with the acknowledgement, which
   * is HR saying they have a reason. Either way the RECORD ends up saying what
   * was decided, which is the property the automatic conversion would have cost.
   */
  async function resolveSickAsks(choice: "half-pay" | "anyway") {
    const asks = sickAsks ?? [];
    setSickAsks(null);
    if (asks.length === 0) return;
    applying.current = true;
    try {
      let written = 0;
      const failures: { name: string; message: string }[] = [];
      for (const ask of asks) {
        try {
          const res = await setAttendance.mutateAsync({
            employeeId: ask.employeeId,
            from: ask.from,
            to: ask.to,
            code: choice === "half-pay" ? HALF_PAY_SICK_CODE : ask.code,
            ...(choice === "anyway" ? { acknowledgeSickTier: true } : {}),
          });
          written += res.written;
        } catch (err) {
          failures.push({ name: ask.name, message: (err as Error).message });
        }
      }
      await qc.invalidateQueries({ queryKey: ["hr"] });
      if (failures.length === 0) {
        toast.success(
          `${written} day${written === 1 ? "" : "s"} recorded as ` +
            (choice === "half-pay" ? `${HALF_PAY_SICK_CODE} (half pay)` : asks[0].code),
        );
        setSel((s) => (s ? collapseToHead(s) : s));
      } else {
        toast.error(failures.map((f) => `${f.name}: ${f.message}`).join("; "));
      }
    } finally {
      applying.current = false;
    }
  }

  async function apply(code: string | null) {
    if (!cellsInSel.length || applying.current) return;
    applying.current = true;
    try {
      const byEmployee = new Map<string, { employee: HrEmployee; dates: CalendarDate[] }>();
      for (const c of cellsInSel) {
        const group = byEmployee.get(c.employee.id) ?? { employee: c.employee, dates: [] };
        group.dates.push(c.date);
        byEmployee.set(c.employee.id, group);
      }
      setPop(null);
      let written = 0, skipped = 0;
      const failures: { name: string; message: string }[] = [];
      // Not a failure: the service refused ONCE so a person can be asked. Held
      // aside so the toast does not call it an error and the dialog can offer
      // the two answers the owner's ruling allows.
      const tierAsks: SickTierAsk[] = [];
      for (const { employee, dates } of byEmployee.values()) {
        const sorted = [...dates].sort();
        try {
          if (code) {
            const res = await setAttendance.mutateAsync({
              employeeId: employee.id,
              from: sorted[0],
              to: sorted[sorted.length - 1],
              code,
              // Deliberately NOT passed: whether a range covers calendar days or
              // only working days is a policy, and it lives in the service so the
              // grid, MCP and any import cannot answer it three different ways.
            });
            written += res.written;
            skipped += res.skipped.length;
          } else {
            const res = await clearAttendance.mutateAsync({
              employeeId: employee.id,
              from: sorted[0],
              to: sorted[sorted.length - 1],
            });
            written += res.removed;
          }
        } catch (err) {
          const e = err as HrWriteError;
          if (code && e.code === "SICK_FULL_TIER_EXCEEDED") {
            tierAsks.push({
              employeeId: employee.id,
              name: employee.name,
              from: sorted[0],
              to: sorted[sorted.length - 1],
              code,
              used: Number(e.data?.used ?? 0),
              wouldBe: Number(e.data?.wouldBe ?? 0),
              limit: Number(e.data?.limit ?? 15),
              leaveYear: Number(e.data?.leaveYear ?? 0),
            });
            continue;
          }
          failures.push({ name: employee.name, message: e.message });
        }
      }
      // ONE refetch for the whole selection. The hooks are told not to
      // invalidate per request; left on, a 23-row drag cancelled and restarted
      // the employees, attendance and codes queries 23 times over (review M10).
      await qc.invalidateQueries({ queryKey: ["hr"] });

      if (tierAsks.length > 0) {
        // Ask BEFORE reporting: the operator has a decision to make, and a
        // success toast underneath an open question reads as "done".
        setSickAsks(tierAsks);
        return;
      }

      const people = byEmployee.size;
      const skippedNote = skipped
        ? `, ${skipped} non-working day${skipped === 1 ? "" : "s"} skipped`
        : "";
      if (failures.length === 0) {
        toast.success(
          code
            ? `${written} day${written === 1 ? "" : "s"} set to ${code}${skippedNote}`
            : `Cleared ${written} ${written === 1 ? "day" : "days"}`,
        );
        // Collapse to the head rather than clearing. Dropping the selection
        // ended every keyboard entry by sending you back to Tab-and-navigate-
        // from-today; keeping the cursor lets you arrow straight on to the next
        // day. After a mouse drag it simply leaves the ring on the last cell,
        // as a spreadsheet would.
        setSel((s) => (s ? collapseToHead(s) : s));
        return;
      }
      // Partial or total failure: say who, with counts, and KEEP the selection
      // so the failed part can be retried with one keypress instead of a new
      // drag. The success toast used to be suppressed outright and the
      // selection dropped, so "4 of 5 people written" looked like nothing
      // written and could not be retried (review M10).
      const who = failures.map((f) => `${f.name}: ${f.message}`).join("; ");
      if (failures.length < people) {
        toast.warning(`Written for ${people - failures.length} of ${people} people. Not written: ${who}`);
      } else {
        toast.error(people === 1 ? who : `Nothing written. ${who}`);
      }
    } finally {
      applying.current = false;
    }
  }

  /* Keyboard is bound at the document, so a shortcut works wherever the pointer
     ended up after a drag. Guarded on an open dialog and on any focused field,
     or typing a date in a modal would set half the grid to Annual. */
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") { setPop(null); setSel(null); return; }
      // The browser owns Cmd/Ctrl/Alt combinations. Without this, Cmd+C on a
      // selection wrote comp-off, Cmd+A annual leave, Cmd+S sick leave and
      // Cmd+W work-from-home as the tab closed (review H4, Aug 31 2026). A held
      // key auto-repeats keydown, so `repeat` is refused too, and nothing is
      // accepted while a write is already in flight.
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (!sel || companyOpen || standingOpen) return;
      const el = ev.target as HTMLElement | null;
      if (el && el.closest("input,select,textarea,[role=dialog]")) return;

      /* Movement first, and it is the one thing a HELD key may repeat.
         `ev.repeat` used to be refused outright, which was right while every
         shortcut WROTE: holding a letter fired the same write thirty times.
         But the rule was never "no repeats", it was "no repeated writes" — a
         blanket guard was only the cheapest way to say that while the two
         coincided. Holding an arrow to cross a month is what anyone expects,
         so the guard is per-action from here down. */
      const step = ARROW_STEP[ev.key];
      if (step) {
        ev.preventDefault();
        setPop(null);
        setSel((s) => (s ? moveSelection(s, step, ev.shiftKey, employees.length, days.length) : s));
        return;
      }
      if (ev.key === "Enter" || ev.key === " ") {
        // Keyboard equivalent of releasing a drag: open the picker on the cell
        // the cursor is actually on, not where the mouse was last seen.
        ev.preventDefault();
        setPop({ r: sel.r1, d: sel.d1 });
        return;
      }

      if (ev.repeat || applying.current) return;
      const code = resolveKeyCode(ev.key, ev.shiftKey);
      if (code) { ev.preventDefault(); void apply(code); return; }
      if (ev.key === "Backspace" || ev.key === "Delete") { ev.preventDefault(); void apply(null); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, companyOpen, standingOpen, cellsInSel, employees.length, days.length]);

  /* Keep the cursor on screen: a month scrolls sideways, and a selection you
     cannot see is worse than none. `nearest` is a no-op while it is visible,
     so this does not fight a mouse drag. */
  useEffect(() => {
    if (!sel) return;
    cellEl(sel.r1, sel.d1)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sel]);

  useEffect(() => {
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      // Anchored to the head CELL, not to where the pointer was released, so
      // the popover follows the cell when the grid scrolls under it (M13).
      if (cellsInSel.length && sel) setPop({ r: sel.r1, d: sel.d1 });
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [cellsInSel, sel]);

  /* ------------------------------------------------------------- counters */
  const { accounted, records } = useMemo(() => {
    let accounted = 0;
    for (const e of employees) {
      for (const d of days) {
        const c = cellFor(e, d);
        if (c.code === "P" || c.code === "OFF" || c.code === "PH" || c.code === "NOT_EMPLOYED") continue;
        accounted++;
      }
    }
    // Contiguous same-code days for one person are one decision, so they count
    // as one record: that is the unit an operator actually enters.
    const byEmp = new Map<string, { d: CalendarDate; code: string }[]>();
    for (const e of data?.entries ?? []) {
      const list = byEmp.get(e.employeeId) ?? [];
      list.push({ d: e.date as CalendarDate, code: e.code });
      byEmp.set(e.employeeId, list);
    }
    let runs = 0;
    for (const list of byEmp.values()) {
      list.sort((a, b) => a.d.localeCompare(b.d));
      for (let i = 0; i < list.length; i++) {
        const prev = list[i - 1];
        const gap = prev ? daysBetween(prev.d, list[i].d) > 1 : true;
        if (!prev || prev.code !== list[i].code || gap) runs++;
      }
    }
    const activeRules = rules.filter(
      (r) => r.startDate <= to && (!r.endDate || r.endDate >= from),
    ).length;
    return { accounted, records: runs + activeRules };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, days, data, rules, from, to]);

  /* ------------------------------------------------------------ rendering */
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <TableProperties className="h-6 w-6 text-primary" />
            Attendance
          </h1>
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
            Drag across the grid to select, then press a key or pick a code. Faint cells are
            worked out; a dot means a standing rule put it there.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex overflow-hidden rounded-lg border bg-card shadow-sm">
            <div className="min-w-[96px] px-4 py-2 text-center">
              <span className="block font-mono text-xl font-semibold tabular-nums">{accounted}</span>
              <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-muted-foreground">
                days shown
              </span>
            </div>
            <div className="min-w-[96px] border-l bg-primary/5 px-4 py-2 text-center">
              <span className="block font-mono text-xl font-semibold tabular-nums text-primary">
                {records}
              </span>
              <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-muted-foreground">
                records
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Previous month" onClick={() => {
              const d = new Date(Date.UTC(year, month - 1, 1));
              setYear(d.getUTCFullYear()); setMonth(d.getUTCMonth()); setSel(null);
            }}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="w-36 text-center text-sm font-medium">{monthLabel}</span>
            <Button variant="ghost" size="icon" aria-label="Next month" onClick={() => {
              const d = new Date(Date.UTC(year, month + 1, 1));
              setYear(d.getUTCFullYear()); setMonth(d.getUTCMonth()); setSel(null);
            }}><ChevronRight className="h-4 w-4" /></Button>
          </div>
          {/* A plain link, not a fetch-and-blob: the browser downloads it, and
              the file is BUILT ON THE SERVER so the export is gated, rate
              limited and audited. Building it here from data already in the
              page would be quicker and would leave no trace of who took a copy
              of the org's sick leave, which is the mistake the registrations
              export was moved server-side to fix. */}
          <Button asChild variant="secondary">
            <a href={`/api/hr/attendance?export=csv&from=${from}&to=${to}`} download>
              <Download className="h-4 w-4" />Export
            </a>
          </Button>
          <Button asChild variant="secondary"><Link href="/hr">Leave summary</Link></Button>
          <Button asChild variant="secondary"><Link href="/hr/employees">Employees</Link></Button>
          <Button asChild variant="secondary"><Link href="/hr/holidays">Holidays</Link></Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setCompanyOpen(true)}>
          <Building2 className="h-4 w-4" /> Company day
        </Button>
        <Button variant="outline" onClick={() => setStandingOpen(true)}>
          <UserCog className="h-4 w-4" /> Standing arrangement
        </Button>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">
          {PRIMARY.map((p) => (
            <span key={p.code} className="mr-2 whitespace-nowrap">
              <kbd className="rounded border border-b-2 px-1 py-0.5 font-mono text-[10px]">
                {p.key.toUpperCase()}
              </kbd>{" "}
              {p.label.toLowerCase()}
            </span>
          ))}
          {HALF_DAY.map((h) => (
            <span key={h.code} className="mr-2 whitespace-nowrap">
              <kbd className="rounded border border-b-2 px-1 py-0.5 font-mono text-[10px]">
                ⇧{h.key.toUpperCase()}
              </kbd>{" "}
              {h.label.toLowerCase()}
            </span>
          ))}
          <span className="mr-2 whitespace-nowrap">
            <kbd className="rounded border border-b-2 px-1 py-0.5 font-mono text-[10px]">←↑↓→</kbd> move
          </span>
          <span className="whitespace-nowrap">
            <kbd className="rounded border border-b-2 px-1 py-0.5 font-mono text-[10px]">⌫</kbd> clear
          </span>
        </span>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        {/* One focusable widget, not 700 focusable cells: Tab reaches the grid
            once and a roving selection moves inside it, which is the standard
            grid pattern and keeps the tab order short. Landing seeds a cursor
            on today so the arrows do something immediately — an empty
            selection would make the first keypress look broken. */}
        <div
          tabIndex={0}
          onFocus={() => {
            if (sel || !employees.length || !days.length) return;
            const d = Math.max(0, days.indexOf(todayIso));
            setSel({ r0: 0, d0: d, r1: 0, d1: d });
          }}
          className="overflow-x-auto rounded-lg border bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {isLoading || loadingEmployees ? (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
            </div>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-muted/50">
                  <th className="sticky left-0 z-10 min-w-[150px] bg-muted/50 px-3 py-2 text-left font-medium">
                    Employee
                  </th>
                  {days.map((d) => {
                    // Same source as the CELLS below, which resolve OFF from
                    // `HR_DEFAULT_WEEKEND_DAYS`. Hardcoding Sat/Sun here meant a
                    // Fri/Sat org would get muted headers over the wrong two
                    // columns: greyed Sat/Sun above Fri/Sat OFF cells.
                    const dow = dayOfWeek(d);
                    const weekend = HR_DEFAULT_WEEKEND_DAYS.includes(dow);
                    const hol = holidays.get(d);
                    return (
                      <th
                        key={d}
                        className={`w-7 px-0 py-1.5 text-center font-mono text-[10px] font-normal tabular-nums ${
                          hol ? "text-slate-500" : weekend ? "text-muted-foreground/60" : ""
                        }`}
                        title={hol ? `${d} — ${hol}` : d}
                      >
                        {Number(d.slice(8, 10))}
                        <span className="block text-[8px] font-normal uppercase text-muted-foreground/60">
                          {DOW[dow]}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y">
                {employees.map((e, r) => (
                  <tr key={e.id} className="hover:bg-muted/20">
                    <td className="sticky left-0 z-10 bg-card px-3 py-1 hover:bg-muted/20">
                      <div className="truncate font-medium" title={e.name}>{e.name}</div>
                      <div className="font-mono text-[9px] text-muted-foreground">{e.empCode}</div>
                    </td>
                    {days.map((d, di) => {
                      const c = cellFor(e, d);
                      const outside = c.code === "NOT_EMPLOYED";
                      const selected = selectedKeys.has(`${e.id}|${d}`);
                      const label =
                        outside ? "" : c.code === "OFF" ? "OFF" : c.code;
                      const style = outside
                        ? "opacity-0"
                        : c.derived
                          ? c.ruleId
                            ? `${CODE_STYLE[c.code] ?? ""} opacity-60`
                            : c.code === "PH"
                              ? CODE_STYLE.PH
                              : DERIVED_STYLE
                          : (CODE_STYLE[c.code] ?? "bg-muted");
                      const why = outside
                        ? "not employed"
                        : c.ruleId
                          ? ruleById.get(c.ruleId)?.label ?? "from a rule"
                          : !c.derived
                            ? "recorded"
                            : c.code === "PH"
                              ? holidays.get(d) ?? "public holiday"
                              : c.code === "OFF"
                                ? "weekend"
                                : "present (assumed)";
                      return (
                        <td key={d} className="p-0 text-center">
                          <div
                            data-cell
                            data-r={r}
                            data-d={di}
                            onMouseDown={(ev) => {
                              if (outside) return;
                              ev.preventDefault();
                              setPop(null);
                              dragging.current = true;
                              setSel({ r0: r, d0: di, r1: r, d1: di });
                            }}
                            onMouseEnter={() => {
                              if (!dragging.current) return;
                              setSel((s) => (s ? { ...s, r1: r, d1: di } : s));
                            }}
                            title={`${d} — ${why}`}
                            className={`relative mx-auto my-0.5 flex h-6 w-[26px] select-none items-center justify-center rounded font-mono text-[9px] ${
                              outside ? "cursor-not-allowed" : "cursor-cell"
                            } ${style} ${selected ? "ring-2 ring-primary ring-inset" : ""}`}
                          >
                            {label}
                            {c.ruleId && (
                              <span className="absolute left-[2px] top-[2px] h-[3px] w-[3px] rounded-full bg-primary/70" />
                            )}
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
          )}
        </div>

        <div className="space-y-3">
          <div className="rounded-lg border bg-card">
            <div className="border-b px-3 py-2.5">
              <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-primary">
                Standing rules
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                One record that speaks for many days. Anything recorded for a person still wins.
              </p>
            </div>
            {rules.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                None yet. A company day covers everyone at once; a standing arrangement covers one
                person until you end it.
              </p>
            ) : (
              <ul className="divide-y">
                {rules.map((r) => (
                  <li key={r.id} className="flex items-start gap-2 px-3 py-2 text-xs">
                    <span
                      className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
                        r.scope === "ORG"
                          ? "bg-primary/10 text-primary"
                          : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                      }`}
                    >
                      {r.scope === "ORG" ? "ALL" : "ONE"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">
                        {r.label} · {r.code}
                      </span>
                      <span className="text-muted-foreground">
                        {r.scope === "EMPLOYEE" ? `${r.employeeName ?? "?"} · ` : ""}
                        {r.startDate}
                        {r.endDate ? ` – ${r.endDate}` : " onwards"}
                      </span>
                    </span>
                    <button
                      className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:text-destructive"
                      title="End this rule"
                      disabled={deleteRule.isPending}
                      onClick={async () => {
                        try {
                          await deleteRule.mutateAsync(r.id);
                          toast.success("Rule removed. Those days go back to being derived.");
                        } catch (err) {
                          toast.error((err as Error).message);
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border bg-card">
            <div className="border-b px-3 py-2.5">
              <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-primary">
                Codes
              </h2>
            </div>
            <div className="flex flex-wrap gap-1.5 px-3 py-3">
              {["AL", "WFH", "SL-F", "OD", "CO", "ABS", "PH"].map((c) => (
                <span
                  key={c}
                  className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold ${CODE_STYLE[c] ?? "bg-muted"}`}
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {pop && cellsInSel.length > 0 && (
        <CodePopover
          anchor={pop}
          count={cellsInSel.length}
          codes={codes}
          onPick={(code) => void apply(code)}
          onClose={() => setPop(null)}
        />
      )}

      <SickTierDialog
        asks={sickAsks}
        halfPayAvailable={codes.some((c) => c.code === HALF_PAY_SICK_CODE)}
        onChoose={(choice) => void resolveSickAsks(choice)}
        onCancel={() => setSickAsks(null)}
      />

      <CompanyDayDialog
        open={companyOpen}
        onOpenChange={setCompanyOpen}
        codes={codes.map((c) => ({ code: c.code, label: c.label }))}
        defaultFrom={from}
        pending={createRule.isPending}
        onSubmit={async (v) => {
          try {
            await createRule.mutateAsync({ scope: "ORG", ...v });
            toast.success("One record now covers everyone employed on those dates.");
            setCompanyOpen(false);
          } catch (err) {
            toast.error((err as Error).message);
          }
        }}
      />

      <StandingDialog
        open={standingOpen}
        onOpenChange={setStandingOpen}
        employees={employees}
        codes={codes.map((c) => ({ code: c.code, label: c.label }))}
        defaultFrom={from}
        pending={createRule.isPending}
        onSubmit={async (v) => {
          try {
            await createRule.mutateAsync({ scope: "EMPLOYEE", ...v });
            toast.success("Recorded once. It applies every working day until you end it.");
            setStandingOpen(false);
          } catch (err) {
            toast.error((err as Error).message);
          }
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------- popover ---- */

function CodePopover(props: {
  anchor: { r: number; d: number }; count: number; codes: { code: string; label: string }[];
  onPick: (code: string | null) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);

  /**
   * Positioned FIXED against the head cell and re-measured on any scroll or
   * resize. The old version was `absolute` in an unpositioned tree with an
   * added document-scroll offset that is always 0 here: the document does not scroll,
   * `<main>` does, so the popover was right at open time, stayed pinned while
   * the grid moved under it, and on a bottom row ran off the viewport (review
   * M13). Written to the element directly rather than through state: it is a
   * measurement of layout, re-run after paint whenever the height can change.
   */
  useLayoutEffect(() => {
    function place() {
      const cell = cellEl(props.anchor.r, props.anchor.d);
      const el = ref.current;
      if (!cell || !el) return;
      const at = placePopover(
        cell.getBoundingClientRect(),
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      el.style.left = `${at.left}px`;
      el.style.top = `${at.top}px`;
      el.style.visibility = "visible";
    }
    place();
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [props.anchor.r, props.anchor.d, showAll]);

  /**
   * Dismiss on a click outside. This is why the secondary codes are an INLINE
   * list and not a Select: Radix renders its list in a PORTAL, so an option is
   * not inside `ref.current`, this handler read the click as "outside",
   * unmounted the popover and took the Select with it before `onValueChange`
   * could fire. The result was a dropdown that opened, offered sixteen codes,
   * and silently did nothing — no error, no toast, no request. Keep everything
   * this popover offers inside its own subtree.
   */
  useEffect(() => {
    function onDown(ev: MouseEvent) {
      const el = ev.target as HTMLElement;
      if (!ref.current?.contains(el) && !el.closest("[data-cell]")) props.onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [props]);

  const shown = new Set([...PRIMARY, ...HALF_DAY].map((p) => p.code));
  const others = props.codes.filter((c) => !shown.has(c.code));

  return (
    <div
      ref={ref}
      style={{ left: 0, top: 0, visibility: "hidden" }}
      className="fixed z-50 w-64 rounded-lg border bg-popover p-2 shadow-lg"
    >
      <p className="mb-1.5 px-1 font-mono text-[11px] text-muted-foreground">
        {props.count} day{props.count === 1 ? "" : "s"} selected
      </p>
      <div className="grid grid-cols-2 gap-1">
        {PRIMARY.map((p) => (
          <button
            key={p.code}
            onClick={() => props.onPick(p.code)}
            className="flex items-center gap-1.5 rounded-md border px-1.5 py-1.5 text-left text-[11px] hover:border-primary"
          >
            <span className={`rounded px-1 py-0.5 font-mono text-[9px] font-semibold ${CODE_STYLE[p.code]}`}>
              {p.code}
            </span>
            {p.label}
          </button>
        ))}
      </div>
      {/* Half days get a labelled row of their own. Left in the unlabelled
          sixteen they sat beside SL-H — a FULL day at half pay — one character
          away from SL-HD, which is half a day at full pay. */}
      <div className="mt-1.5 grid grid-cols-2 gap-1 border-t pt-1.5">
        {HALF_DAY.map((h) => (
          <button
            key={h.code}
            onClick={() => props.onPick(h.code)}
            title={`${h.code}: half a day, full pay`}
            className="flex items-center gap-1.5 rounded-md border px-1.5 py-1.5 text-left text-[11px] hover:border-primary"
          >
            <span className={`rounded px-1 py-0.5 font-mono text-[9px] font-semibold ${CODE_STYLE[h.code]}`}>
              ½
            </span>
            {h.label}
          </button>
        ))}
      </div>
      {others.length > 0 && (
        <div className="mt-1.5 border-t pt-1.5">
          {showAll ? (
            /* One labelled row each, not a three-column grid of bare codes.
               The label is the whole point: SL-H, SL-HD, SL-F and SL-U are
               four different entitlements whose codes differ by a character. */
            <div className="grid max-h-44 grid-cols-1 gap-1 overflow-y-auto">
              {others.map((c) => (
                <button
                  key={c.code}
                  onClick={() => props.onPick(c.code)}
                  title={c.label}
                  className="flex items-center gap-2 rounded-md border px-1.5 py-1 text-left text-[10px] hover:border-primary"
                >
                  <span className="w-10 shrink-0 font-mono text-[9px] font-semibold text-muted-foreground">
                    {c.code}
                  </span>
                  <span className="truncate">{c.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <button
              onClick={() => setShowAll(true)}
              className="w-full rounded-md py-1.5 text-[11px] text-muted-foreground hover:bg-muted"
            >
              Another code… ({others.length})
            </button>
          )}
        </div>
      )}
      <button
        onClick={() => props.onPick(null)}
        title="Removes the record. The day goes back to being worked out: Present on a working day, OFF at a weekend, PH on a public holiday."
        className="mt-1.5 w-full rounded-md py-1.5 text-[11px] text-muted-foreground hover:bg-muted"
      >
        Clear these days
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- dialogs --- */

/**
 * "This person is past 15 days of full-pay sick leave. What should it be?"
 *
 * Three answers, and the DEFAULT is the lawful one: past 15 days the
 * entitlement is half pay, so SL-H is the primary button. Recording full pay
 * anyway stays available because HR sometimes has a reason and the system is
 * not the one making this call (owner ruling, Aug 31 2026) — but it is the
 * quieter button, because it is the exception.
 */
function SickTierDialog(props: {
  asks: SickTierAsk[] | null;
  halfPayAvailable: boolean;
  onChoose: (choice: "half-pay" | "anyway") => void;
  onCancel: () => void;
}) {
  const asks = props.asks ?? [];
  const open = asks.length > 0;
  const original = asks[0]?.code ?? "";
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) props.onCancel(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Past 15 days of full-pay sick leave</DialogTitle>
          <DialogDescription>
            UAE law (Art. 31) gives 15 days at full pay, then 30 at half pay. Nothing has
            been recorded yet.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 rounded-md border bg-muted/40 p-3 text-sm">
          {asks.map((a) => (
            <li key={a.employeeId} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{a.name}</span>
              <span className="text-muted-foreground tabular-nums">
                has used {a.used} of {a.limit} in {a.leaveYear}; this would make it {a.wouldBe}.
              </span>
            </li>
          ))}
        </ul>
        {!props.halfPayAvailable && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            There is no active <b>{HALF_PAY_SICK_CODE}</b> code on this organisation, so the
            half-pay option cannot be recorded. Add it under leave codes first.
          </p>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={props.onCancel}>Cancel</Button>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => props.onChoose("anyway")}>
              Record as {original} anyway
            </Button>
            <Button disabled={!props.halfPayAvailable} onClick={() => props.onChoose("half-pay")}>
              Record as {HALF_PAY_SICK_CODE} (half pay)
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompanyDayDialog(props: {
  open: boolean; onOpenChange: (v: boolean) => void;
  codes: { code: string; label: string }[]; defaultFrom: string; pending: boolean;
  onSubmit: (v: { code: string; startDate: string; endDate: string | null; label: string }) => void;
}) {
  const [form, setForm] = useState({ startDate: "", endDate: "", code: "WFH", label: "Everyone remote" });
  const [prevOpen, setPrevOpen] = useState(props.open);
  if (props.open !== prevOpen) {
    setPrevOpen(props.open);
    // Re-seed on every closed -> open transition, so yesterday's half-typed
    // range is not still sitting there tomorrow.
    if (props.open) {
      setForm({ startDate: props.defaultFrom, endDate: "", code: "WFH", label: "Everyone remote" });
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" /> Company day
          </DialogTitle>
          <DialogDescription>
            One record that applies to everyone employed on those dates. Anything already recorded
            for a person still wins, so somebody on leave stays on leave.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">From</Label>
              <Input type="date" value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To (optional)</Label>
              <Input type="date" value={form.endDate}
                onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Code</Label>
            <Select value={form.code} onValueChange={(v) => setForm((f) => ({ ...f, code: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {props.codes.map((c) => (
                  <SelectItem key={c.code} value={c.code}>{c.code} — {c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Why</Label>
            <Input value={form.label} placeholder="Office closed, Ramadan hours…"
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
          </div>
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            A working code such as WFH covers working days only. Annual leave, on-duty and
            comp-off cover every day in the range, weekends and public holidays included,
            exactly as the same block recorded on the grid would. A company day that is leave
            also applies to anyone with a standing working arrangement such as WFH: the
            shutdown wins, and their arrangement resumes when it ends. Nothing is written per
            person, so ending this rule later puts every day back exactly as it was.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={props.pending || !form.startDate || !form.label.trim()}
            onClick={() => props.onSubmit({
              code: form.code,
              startDate: form.startDate,
              endDate: form.endDate || null,
              label: form.label.trim(),
            })}
          >
            {props.pending && <Loader2 className="h-4 w-4 animate-spin" />} Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StandingDialog(props: {
  open: boolean; onOpenChange: (v: boolean) => void;
  employees: HrEmployee[]; codes: { code: string; label: string }[];
  defaultFrom: string; pending: boolean;
  onSubmit: (v: {
    employeeId: string; code: string; startDate: string; endDate: string | null; label: string;
  }) => void;
}) {
  const [form, setForm] = useState({
    employeeId: "", startDate: "", endDate: "", code: "WFH", label: "Works remotely",
  });
  const [prevOpen, setPrevOpen] = useState(props.open);
  if (props.open !== prevOpen) {
    setPrevOpen(props.open);
    if (props.open) {
      setForm({
        employeeId: "", startDate: props.defaultFrom, endDate: "", code: "WFH",
        label: "Works remotely",
      });
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" /> Standing arrangement
          </DialogTitle>
          <DialogDescription>
            Something permanently true about one person. It fills every working day until you end
            it (every day, for annual leave, on-duty or comp-off). Any individual record still
            overrides it, and so does a company day that is leave: during a shutdown a remote
            worker is on leave with everyone else.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Person</Label>
            <Select value={form.employeeId}
              onValueChange={(v) => setForm((f) => ({ ...f, employeeId: v }))}>
              <SelectTrigger><SelectValue placeholder="Pick someone" /></SelectTrigger>
              <SelectContent>
                {props.employees.map((e) => (
                  <SelectItem key={e.id} value={e.id}>{e.name} ({e.empCode})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">From</Label>
              <Input type="date" value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Until (optional)</Label>
              <Input type="date" value={form.endDate}
                onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Code</Label>
            <Select value={form.code} onValueChange={(v) => setForm((f) => ({ ...f, code: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {props.codes.map((c) => (
                  <SelectItem key={c.code} value={c.code}>{c.code} — {c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Why</Label>
            <Input value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
          </div>
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            Leave &ldquo;Until&rdquo; empty for an open-ended arrangement. It holds until somebody
            ends it.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={props.pending || !form.employeeId || !form.startDate || !form.label.trim()}
            onClick={() => props.onSubmit({
              employeeId: form.employeeId,
              code: form.code,
              startDate: form.startDate,
              endDate: form.endDate || null,
              label: form.label.trim(),
            })}
          >
            {props.pending && <Loader2 className="h-4 w-4 animate-spin" />} Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
