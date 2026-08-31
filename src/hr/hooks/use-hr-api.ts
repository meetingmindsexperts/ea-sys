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
  hasCompletedFirstYear: boolean;
  nextAnniversary: string;
  annual: {
    entitlement: number;
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

export function useSetHrAttendance() {
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
      void qc.invalidateQueries({ queryKey: ["hr"] });
    },
  });
}

export function useClearHrAttendance() {
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
      void qc.invalidateQueries({ queryKey: ["hr"] });
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
  notes?: string | null;
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

export function useHrEmployeeExit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, exitDate, status }: { id: string; exitDate: string; status: "RESIGNED" | "TERMINATED" }) =>
      send<{ employee: HrEmployee }>(`/api/hr/employees/${id}/exit`, "POST", { exitDate, status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["hr"] }),
  });
}
