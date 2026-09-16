"use client";

/**
 * React Query hooks for custom roles (Settings → Roles, and the per-person
 * assignment dialog).
 *
 * Its own module rather than another entry in the 1,000-line `use-api.ts`:
 * two screens consume these and nothing else does, so the surface stays
 * findable next to the feature it serves.
 */

import { useQuery } from "@tanstack/react-query";

export interface PermissionSetRow {
  id: string;
  name: string;
  description: string | null;
  version: number;
  archivedAt: string | null;
  permissions: { permission: string }[];
  holderCount: number;
}

export const permissionSetKeys = {
  all: ["permission-sets"] as const,
  list: (includeArchived: boolean) => ["permission-sets", { includeArchived }] as const,
  forUser: (userId: string | null) => ["permission-sets", "user", userId] as const,
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Request failed");
  }
  return res.json();
}

export function usePermissionSets(opts: { includeArchived?: boolean; enabled?: boolean } = {}) {
  const includeArchived = opts.includeArchived ?? false;
  return useQuery({
    queryKey: permissionSetKeys.list(includeArchived),
    queryFn: () => getJson<PermissionSetRow[]>(`/api/organization/permission-sets${includeArchived ? "?includeArchived=1" : ""}`),
    enabled: opts.enabled ?? true,
  });
}

/** Which roles one person holds. Disabled until a person is actually selected. */
export function useUserPermissionSets(userId: string | null) {
  return useQuery({
    queryKey: permissionSetKeys.forUser(userId),
    queryFn: () => getJson<{ permissionSetIds: string[] }>(`/api/organization/users/${userId}/permission-sets`),
    enabled: !!userId,
  });
}
