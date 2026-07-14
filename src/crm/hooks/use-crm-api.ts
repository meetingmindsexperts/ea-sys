"use client";

/**
 * CRM React Query hooks.
 *
 * Lives in src/crm/ rather than growing src/hooks/use-api.ts — the module owns its
 * own data layer (§7.0/§7.5), and core never imports it.
 *
 * The interesting hook is `useMoveDealStage`. Dragging a card must feel instant, so
 * the move is applied OPTIMISTICALLY — but the server can legitimately refuse it
 * (409 STAGE_CHANGED) when a colleague moved the same card first. So the hook:
 *   1. snapshots the board,
 *   2. moves the card locally,
 *   3. on failure, restores the snapshot and refetches — because on a 409 the truth
 *      is on the server, and guessing "well, put it back where it was" is wrong if
 *      the colleague moved it somewhere else entirely.
 * An optimistic update with no rollback path is a lie the UI tells the user.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, apiFetch, apiPostJson, apiPatchJson, apiDelete } from "@/lib/api-fetch";
import type {
  CrmBoardDeal,
  CrmCompanyRow,
  CrmCompanyDetail,
  CrmNoteRow,
  CrmStage,
  CrmTaskRow,
} from "@/crm/lib/crm-types";

export const crmKeys = {
  stages: ["crm", "stages"] as const,
  deals: (filters?: { eventId?: string; ownerId?: string }) =>
    ["crm", "deals", filters ?? {}] as const,
  deal: (id: string) => ["crm", "deal", id] as const,
  companies: (q?: string) => ["crm", "companies", q ?? ""] as const,
  company: (id: string) => ["crm", "company", id] as const,
  tasks: (scope?: string) => ["crm", "tasks", scope ?? "mine"] as const,
  notes: (attach: Record<string, string>) => ["crm", "notes", attach] as const,
};

// ── Pipeline ─────────────────────────────────────────────────────────────────

export function useCrmStages() {
  return useQuery({
    queryKey: crmKeys.stages,
    queryFn: () => apiFetch<{ stages: CrmStage[] }>("/api/crm/pipeline-stages").then((r) => r.stages),
  });
}

// ── Deals ────────────────────────────────────────────────────────────────────

export function useCrmDeals(filters: { eventId?: string; ownerId?: string } = {}) {
  const qs = new URLSearchParams();
  if (filters.eventId) qs.set("eventId", filters.eventId);
  if (filters.ownerId) qs.set("ownerId", filters.ownerId);
  const suffix = qs.toString() ? `?${qs}` : "";

  return useQuery({
    queryKey: crmKeys.deals(filters),
    queryFn: () => apiFetch<{ deals: CrmBoardDeal[] }>(`/api/crm/deals${suffix}`).then((r) => r.deals),
  });
}

export function useCreateDeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPostJson<{ deal: CrmBoardDeal }>("/api/crm/deals", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm", "deals"] });
      qc.invalidateQueries({ queryKey: ["crm", "companies"] });
    },
  });
}

export function useUpdateDeal(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPatchJson<{ deal: CrmBoardDeal }>(`/api/crm/deals/${dealId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm", "deals"] });
      qc.invalidateQueries({ queryKey: crmKeys.deal(dealId) });
    },
  });
}

/**
 * Move a deal between pipeline stages — optimistic, with a real rollback.
 *
 * `fromStageId` is the stage the card was in when the user picked it up, and the
 * server makes it a precondition. If a colleague moved the same card first we get
 * a 409 STAGE_CHANGED; we then restore the snapshot AND refetch, rather than
 * "putting it back" — because the card may now be somewhere neither of us expects,
 * and the server is the only thing that knows where.
 */
export function useMoveDealStage(filters: { eventId?: string; ownerId?: string } = {}) {
  const qc = useQueryClient();
  const key = crmKeys.deals(filters);

  return useMutation({
    mutationFn: ({ dealId, fromStageId, toStageId }: { dealId: string; fromStageId: string; toStageId: string }) =>
      apiPatchJson<{ deal: CrmBoardDeal }>(`/api/crm/deals/${dealId}/stage`, { fromStageId, toStageId }),

    onMutate: async ({ dealId, toStageId }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<CrmBoardDeal[]>(key);

      qc.setQueryData<CrmBoardDeal[]>(key, (old) =>
        (old ?? []).map((d) => (d.id === dealId ? { ...d, stageId: toStageId } : d)),
      );

      return { previous };
    },

    onError: (err, _vars, context) => {
      // Restore what the user saw before the drag…
      if (context?.previous) qc.setQueryData(key, context.previous);

      if (err instanceof ApiError && err.code === "STAGE_CHANGED") {
        toast.error("Someone else moved this deal", {
          description: "The board has been refreshed with the latest positions.",
        });
      } else {
        toast.error(err instanceof Error ? err.message : "Could not move the deal");
      }

      // …then go and get the truth. A 409 means our snapshot is stale too.
      qc.invalidateQueries({ queryKey: key });
    },

    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
    },
  });
}

export function useCloseDeal(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { outcome: "WON" | "LOST"; lostReason?: string | null }) =>
      apiPostJson<{ deal: CrmBoardDeal }>(`/api/crm/deals/${dealId}/close`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm", "deals"] });
      qc.invalidateQueries({ queryKey: crmKeys.deal(dealId) });
    },
  });
}

// ── Companies ────────────────────────────────────────────────────────────────

export function useCrmCompanies(q?: string) {
  return useQuery({
    queryKey: crmKeys.companies(q),
    queryFn: () =>
      apiFetch<{ companies: CrmCompanyRow[] }>(
        `/api/crm/companies${q ? `?q=${encodeURIComponent(q)}` : ""}`,
      ).then((r) => r.companies),
  });
}

export function useCrmCompany(companyId: string | null) {
  return useQuery({
    queryKey: crmKeys.company(companyId ?? ""),
    queryFn: () =>
      apiFetch<{ company: CrmCompanyDetail }>(`/api/crm/companies/${companyId}`).then((r) => r.company),
    enabled: !!companyId,
  });
}

export function useCreateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPostJson<{ company: CrmCompanyRow; created: boolean; needsReview: boolean }>(
        "/api/crm/companies",
        body,
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["crm", "companies"] });
      // find-or-create: say what actually happened, rather than claiming we made
      // something we merely found.
      if (!res.created) {
        toast.info(`Linked to the existing account "${res.company.name}"`);
      } else if (res.needsReview) {
        toast.warning(`Created "${res.company.name}"`, {
          description: "It looks similar to an existing account — flagged for review.",
        });
      } else {
        toast.success(`Created "${res.company.name}"`);
      }
    },
  });
}

export function useUpdateCompany(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPatchJson<{ company: CrmCompanyRow }>(`/api/crm/companies/${companyId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm", "companies"] });
      qc.invalidateQueries({ queryKey: crmKeys.company(companyId) });
    },
  });
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export function useCrmTasks(scope: "mine" | "all" = "mine", status: "OPEN" | "DONE" | "all" = "OPEN") {
  return useQuery({
    queryKey: [...crmKeys.tasks(scope), status],
    queryFn: () =>
      apiFetch<{ tasks: CrmTaskRow[] }>(`/api/crm/tasks?scope=${scope}&status=${status}`).then((r) => r.tasks),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPostJson<{ task: CrmTaskRow }>("/api/crm/tasks", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm", "tasks"] });
      qc.invalidateQueries({ queryKey: ["crm", "deal"] });
    },
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, ...body }: { taskId: string } & Record<string, unknown>) =>
      apiPatchJson<{ task: CrmTaskRow }>(`/api/crm/tasks/${taskId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm", "tasks"] });
      qc.invalidateQueries({ queryKey: ["crm", "deal"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update the task"),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => apiDelete(`/api/crm/tasks/${taskId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["crm", "tasks"] }),
  });
}

// ── Notes ────────────────────────────────────────────────────────────────────

export function useCrmNotes(attach: { dealId?: string; companyId?: string; contactId?: string }) {
  const qs = new URLSearchParams(
    Object.entries(attach).filter(([, v]) => !!v) as [string, string][],
  );
  const enabled = qs.toString().length > 0;

  return useQuery({
    queryKey: crmKeys.notes(Object.fromEntries(qs) as Record<string, string>),
    queryFn: () => apiFetch<{ notes: CrmNoteRow[] }>(`/api/crm/notes?${qs}`).then((r) => r.notes),
    enabled,
  });
}

export function useCreateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPostJson<{ note: CrmNoteRow }>("/api/crm/notes", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm", "notes"] });
      qc.invalidateQueries({ queryKey: ["crm", "deal"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save the note"),
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (noteId: string) => apiDelete(`/api/crm/notes/${noteId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm", "notes"] });
      qc.invalidateQueries({ queryKey: ["crm", "deal"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete the note"),
  });
}
