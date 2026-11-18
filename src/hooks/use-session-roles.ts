"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApi } from "@/hooks/use-api";
import type { SessionRoleDef, SessionRoleDuty } from "@/lib/session-roles";

/**
 * The organisation's session roles (Nov 18, 2026; docs/SESSION_ROLES_PLAN.md),
 * with how many session assignments hold each. One cache entry, read by the
 * Settings card and by every agenda picker.
 */
export type SessionRoleRow = SessionRoleDef & { assignments: number };

export const SESSION_ROLES_KEY = ["organization", "session-roles"] as const;

export function useSessionRoles() {
  return useQuery({
    queryKey: SESSION_ROLES_KEY,
    queryFn: () => fetchApi<{ roles: SessionRoleRow[] }>("/api/organization/session-roles").then((d) => d.roles),
  });
}

export function useSaveSessionRoles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (roles: { key?: string; label: string; duty: SessionRoleDuty; hidden: boolean }[]) =>
      fetchApi<{ roles: SessionRoleRow[] }>("/api/organization/session-roles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles }),
      }).then((d) => d.roles),
    onSuccess: (roles) => queryClient.setQueryData(SESSION_ROLES_KEY, roles),
  });
}
