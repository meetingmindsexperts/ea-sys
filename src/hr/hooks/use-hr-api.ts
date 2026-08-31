"use client";

/**
 * React Query hooks for the HR module. Mirrors src/hooks/use-api.ts in shape;
 * separate file because the import boundary is one-way and core must not reach
 * in here.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface HrEmployee {
  id: string;
  empCode: string;
  name: string;
  department: string | null;
  jobTitle: string | null;
  joiningDate: string;
  exitDate: string | null;
  status: string;
  carryoverDays: number;
  openingSickUsed: number;
  openingCompOff: number;
  /** An agreed figure replacing the standard entitlement; null means use the rule. */
  annualEntitlementDays: number | null;
  /** The leave year the carry-over and opening-sick seeds belong to. */
  seedLeaveYear: number | null;
  userId: string | null;
  notes: string | null;
}

export interface HrTier {
  used: number;
  limit: number;
  remaining: number;
}

export interface HrBalance {
  leaveYear: number;
  asOf: string;
  /** False when the person was not employed at any point in `leaveYear`; every
   *  annual and sick figure is then zero and must be rendered as "not employed". */
  employedInYear: boolean;
  hasCompletedFirstYear: boolean;
  nextAnniversary: string;
  annual: {
    entitlement: number;
    entitlementOverridden: boolean;
    carriedIn: number;
    carriedInStored: number;
    taken: number;
    balance: number;
  };
  sick: { full: HrTier; half: HrTier; unpaid: HrTier };
  compOff: {
    opening: number;
    earned: number;
    taken: number;
    balance: number;
    earnings: { from: string; to: string }[];
  };
}

export interface HrSummaryRow {
  employee: HrEmployee;
  balance: HrBalance;
}

export interface HrLeaveCode {
  id: string;
  code: string;
  label: string;
  lawReference: string | null;
  paid: boolean;
  dayWeight: number;
  countsAs: string;
  sortOrder: number;
}

export interface HrAttendanceEntry {
  employeeId: string;
  date: string;
  code: string;
  category: string;
  dayWeight: number;
  remarks: string | null;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export const hrKeys = {
  employees: (includeExited: boolean) => ["hr", "employees", includeExited] as const,
  summary: (year: number | undefined) => ["hr", "summary", year ?? "current"] as const,
  leaveCodes: () => ["hr", "leave-codes"] as const,
  attendance: (from: string, to: string, employeeId?: string) =>
    ["hr", "attendance", from, to, employeeId ?? "all"] as const,
};

export function useHrEmployees(includeExited = false) {
  return useQuery({
    queryKey: hrKeys.employees(includeExited),
    queryFn: () =>
      get<{ employees: HrEmployee[] }>(
        `/api/hr/employees?includeExited=${includeExited}`,
      ).then((r) => r.employees),
  });
}

export function useHrSummary(year?: number, includeExited = false) {
  return useQuery({
    queryKey: [...hrKeys.summary(year), includeExited],
    queryFn: () =>
      get<{ summary: HrSummaryRow[] }>(
        `/api/hr/summary?${year ? `year=${year}&` : ""}includeExited=${includeExited}`,
      ).then((r) => r.summary),
  });
}

export function useHrLeaveCodes() {
  return useQuery({
    queryKey: hrKeys.leaveCodes(),
    queryFn: () => get<{ leaveCodes: HrLeaveCode[] }>("/api/hr/leave-codes").then((r) => r.leaveCodes),
    staleTime: 30 * 60 * 1000,
  });
}

/**
 * A standing rule, as the grid needs it. `endDate` null means open-ended, which
 * is what a permanent arrangement is.
 */
export interface HrAttendanceRule {
  id: string;
  scope: "ORG" | "EMPLOYEE";
  employeeId: string | null;
  employeeName: string | null;
  code: string;
  category: string;
  dayWeight: number;
  startDate: string;
  endDate: string | null;
  label: string;
  createdAt: string;
}

export function useHrAttendance(from: string, to: string, employeeId?: string) {
  return useQuery({
    queryKey: hrKeys.attendance(from, to, employeeId),
    queryFn: () =>
      get<{
        entries: HrAttendanceEntry[];
        holidays: { date: string; label: string }[];
        rules: HrAttendanceRule[];
      }>(
        `/api/hr/attendance?from=${from}&to=${to}${employeeId ? `&employeeId=${employeeId}` : ""}`,
      ),
  });
}

export function useCreateHrAttendanceRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      scope: "ORG" | "EMPLOYEE";
      employeeId?: string | null;
      code: string;
      startDate: string;
      endDate?: string | null;
      label: string;
    }) => {
      const res = await fetch("/api/hr/attendance-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not save that rule.");
      return data as { rule: HrAttendanceRule };
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["hr"] }),
  });
}

export function useDeleteHrAttendanceRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ruleId: string) => {
      const res = await fetch(`/api/hr/attendance-rules/${ruleId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not remove that rule.");
      return data as { ok: true };
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["hr"] }),
  });
}

/**
 * `invalidate: false` is for a caller that writes several requests in a row
 * and refetches ONCE afterwards (the grid, one request per person in a
 * multi-row selection). Left on, a 23-row drag cancelled and restarted every
 * HR query 23 times over (review M10).
 */
export function useSetHrAttendance(opts: { invalidate?: boolean } = {}) {
  const { invalidate = true } = opts;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      employeeId: string;
      from: string;
      to?: string;
      code: string;
      remarks?: string | null;
      includeNonWorkingDays?: boolean;
    }) => {
      const res = await fetch("/api/hr/attendance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      return body as { written: number; skipped: string[] };
    },
    onSuccess: () => {
      if (invalidate) void qc.invalidateQueries({ queryKey: ["hr"] });
    },
  });
}

export function useClearHrAttendance(opts: { invalidate?: boolean } = {}) {
  const { invalidate = true } = opts;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { employeeId: string; from: string; to?: string }) => {
      const res = await fetch("/api/hr/attendance", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      return body as { removed: number };
    },
    onSuccess: () => {
      if (invalidate) void qc.invalidateQueries({ queryKey: ["hr"] });
    },
  });
}

export interface HrEmployeeInput {
  empCode: string;
  name: string;
  department?: string | null;
  jobTitle?: string | null;
  joiningDate: string;
  exitDate?: string | null;
  carryoverDays?: number;
  openingSickUsed?: number;
  openingCompOff?: number;
  annualEntitlementDays?: number | null;
  notes?: string | null;
  /**
   * Editable on the edit path, not on create: a new employee is Active by
   * definition. Sent alongside `exitDate` so the two can be corrected together
   * — an Active employee carrying a leaving date is the state that could not be
   * fixed before, because neither field reached the update payload.
   */
  status?: "ACTIVE" | "RESIGNED" | "TERMINATED";
}

async function send<T>(url: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(parsed?.error ?? `Request failed (${res.status})`);
  return parsed as T;
}

/**
 * One employee's balance, for their record page.
 *
 * Its own query rather than filtering the org summary: the page is opened for a
 * LEAVER as often as for anybody, and the summary excludes them by default. A
 * shared cache would have to be fetched with includeExited just in case, which
 * is the whole table for one row.
 */
export function useHrBalance(employeeId: string | undefined, year?: number) {
  return useQuery({
    queryKey: ["hr", "balance", employeeId ?? "none", year ?? "current"],
    enabled: !!employeeId,
    queryFn: () =>
      get<{ employee: HrEmployee; balance: HrBalance }>(
        `/api/hr/balances/${employeeId}${year ? `?year=${year}` : ""}`,
      ),
  });
}

export function useCreateHrEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: HrEmployeeInput) =>
      send<{ employee: HrEmployee }>("/api/hr/employees", "POST", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["hr"] }),
  });
}

export function useUpdateHrEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<HrEmployeeInput> & { id: string }) =>
      send<{ employee: HrEmployee }>(`/api/hr/employees/${id}`, "PATCH", patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["hr"] }),
  });
}

export interface HrYearRollResult {
  fromYear: number;
  toYear: number;
  granted: number;
  skipped: number;
  capped: { employeeId: string; empCode: string; closing: number; carried: number }[];
}

/**
 * Re-run the year-end roll for one closed year. The worker does this nightly
 * through January; this is the manual re-run after a later correction, and it
 * is idempotent, so pressing it twice cannot do harm.
 */
export function useRollHrLeaveYear() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fromYear: number) =>
      send<{ result: HrYearRollResult }>("/api/hr/leave-year/roll", "POST", { fromYear }).then(
        (r) => r.result,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["hr"] }),
  });
}

export function useHrEmployeeExit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, exitDate, status }: { id: string; exitDate: string; status: "RESIGNED" | "TERMINATED" }) =>
      send<{ employee: HrEmployee }>(`/api/hr/employees/${id}/exit`, "POST", { exitDate, status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["hr"] }),
  });
}

export interface HrHoliday {
  id: string;
  date: string;
  label: string;
}

export function useHrHolidays() {
  return useQuery({
    queryKey: ["hr", "holidays"] as const,
    queryFn: () => get<{ holidays: HrHoliday[] }>("/api/hr/holidays").then((r) => r.holidays),
  });
}

export function useCreateHrHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { date: string; label: string }) =>
      send<{ holiday: HrHoliday }>("/api/hr/holidays", "POST", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["hr"] }),
  });
}

export function useDeleteHrHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (holidayId: string) => {
      const res = await fetch(`/api/hr/holidays/${holidayId}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      return body as { ok: true };
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["hr"] }),
  });
}
