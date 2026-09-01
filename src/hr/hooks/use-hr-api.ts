"use client";

/**
 * React Query hooks for the HR module. Mirrors src/hooks/use-api.ts in shape;
 * separate file because the import boundary is one-way and core must not reach
 * in here.
 *
 * EVERY fetch in this file goes through `get` or `send`, and both throw
 * core's `ApiError`, which carries the HTTP `status`. That is not tidiness.
 * `QueryCache.onError` reads `.status` to tell an expired session from a real
 * fault (`src/lib/session-expiry.ts`), so an error thrown without one leaves a
 * stale tab rendering EMPTY HR screens instead of sending the person to sign
 * in. This module shipped with eight hand-written `new Error(...)` throw sites
 * and none of them carried a status, which is how production logged a burst of
 * `hr/*:unauthorized` with nobody being told they were logged out. It is the
 * same defect the CRM had in Aug 2026, reintroduced by a module written after
 * the fix, because a cross-cutting handler that reads a convention only
 * protects code that happens to follow it.
 *
 * So: no `new Error(` below this line. Pinned by a source-level guard in
 * `__tests__/lib/query-fetcher-status.test.ts`, which covers every React Query
 * fetch layer in the app for the same reason.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "@/lib/api-fetch";

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

/**
 * Every HR page renders the thrown message, so the one refusal a person is
 * actually likely to meet is worded once here rather than at each call site.
 * "Forbidden" is accurate and tells them nothing about what to do next.
 */
const HR_FORBIDDEN_MESSAGE =
  "You do not have access to the HR module. If you need it, ask a system administrator to grant it under Settings, Users.";

/** Exported as a test seam only; hooks are the intended way in. */
export async function get<T>(url: string): Promise<T> {
  try {
    return await apiFetch<T>(url);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      throw new ApiError(HR_FORBIDDEN_MESSAGE, err.status, err.data);
    }
    throw err;
  }
}

/**
 * The one write path. `fallback` replaces the generic message ONLY when the
 * server sent no `error` field at all, which is what an unhandled 500 looks
 * like: Next answers with HTML, the parse falls back to `{}`, and a bare
 * "Request failed" is the least useful thing to put in front of somebody.
 *
 * The condition reads `err.data`, the same thing `apiFetch` reads, rather than
 * comparing against its fallback STRING. A string comparison would go quietly
 * dead the day core reworded it.
 */
/** Exported as a test seam only; hooks are the intended way in. */
export async function send<T>(url: string, method: string, body?: unknown, fallback?: string): Promise<T> {
  try {
    return await apiFetch<T>(url, {
      method,
      ...(body !== undefined && {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  } catch (err) {
    if (fallback && err instanceof ApiError && typeof err.data?.error !== "string") {
      throw new ApiError(fallback, err.status, err.data);
    }
    throw err;
  }
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
      return send<{ rule: HrAttendanceRule }>(
        "/api/hr/attendance-rules",
        "POST",
        input,
        "Could not save that rule.",
      );
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["hr"] }),
  });
}

export function useDeleteHrAttendanceRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) =>
      send<{ ok: true }>(
        `/api/hr/attendance-rules/${ruleId}`,
        "DELETE",
        undefined,
        "Could not remove that rule.",
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["hr"] }),
  });
}

/**
 * `invalidate: false` is for a caller that writes several requests in a row
 * and refetches ONCE afterwards (the grid, one request per person in a
 * multi-row selection). Left on, a 23-row drag cancelled and restarted every
 * HR query 23 times over (review M10).
 */
/**
 * An HR write failure is core's `ApiError`: it already carries `status`, the
 * service's own `code`, and the response `data` it came with. Re-exported under
 * the module's own name so HR callers do not each reach across the boundary,
 * and so there is ONE error shape rather than a fifth one invented here.
 */
export { ApiError as HrWriteError } from "@/lib/api-fetch";

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
      /** Proceed past the 15-day full-pay sick limit; see SetAttendanceInput. */
      acknowledgeSickTier?: boolean;
    }) => {
      // The service's CODE travels with the error, because one of them is not
      // a failure at all: SICK_FULL_TIER_EXCEEDED is a question the grid has to
      // put to the operator, and prose cannot be branched on without matching a
      // message string. `ApiError` carries both the code and the whole body.
      //
      // Note the route SPREADS `meta` at the top level of the body rather than
      // nesting it, so the numbers are read from `err.data` directly.
      return send<{ written: number; skipped: string[] }>("/api/hr/attendance", "PUT", input);
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
    mutationFn: (input: { employeeId: string; from: string; to?: string }) =>
      send<{ removed: number }>("/api/hr/attendance", "DELETE", input),
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
    mutationFn: (holidayId: string) =>
      send<{ ok: true }>(`/api/hr/holidays/${holidayId}`, "DELETE"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["hr"] }),
  });
}
