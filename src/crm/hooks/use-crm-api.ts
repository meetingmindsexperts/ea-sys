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
  CrmActivityRow,
  CrmActivityEntityType,
  CrmBoardDeal,
  CrmCompanyRow,
  CrmCompanyDetail,
  CrmContactRow,
  CrmContactDetail,
  CrmDealContactRole,
  CrmNoteRow,
  CrmNotificationRow,
  CrmStage,
  CrmTaskRow,
  CrmEmailTemplateRow,
  CrmProductRow,
  CrmDealProductRow,
  SponsorRecipient,
} from "@/crm/lib/crm-types";

export interface CrmDealFilters {
  eventId?: string;
  ownerId?: string;
  status?: string;
  dateField?: string;
  from?: string;
  to?: string;
  min?: string;
  max?: string;
  archived?: string;
}

/**
 * The ONE place CRM query keys are spelled. Every read AND every invalidation
 * goes through this factory — a raw ["crm", …] literal at a call site is how
 * the contact page went stale (["crm","contact",id] is NOT a prefix of
 * ["crm","contacts"], so a literal invalidation quietly missed the open page).
 *
 * Full keys (reads) always START WITH their matching `*Prefix` (invalidations),
 * so invalidating a prefix reaches every filter variant + detail page.
 */
export const crmKeys = {
  stages: ["crm", "stages"] as const,
  deals: (filters?: CrmDealFilters) =>
    ["crm", "deals", filters ?? {}] as const,
  deal: (id: string) => ["crm", "deal", id] as const,
  companies: (q?: string) => ["crm", "companies", q ?? ""] as const,
  company: (id: string) => ["crm", "company", id] as const,
  tasks: (scope?: string) => ["crm", "tasks", scope ?? "mine"] as const,
  notes: (attach: Record<string, string>) => ["crm", "notes", attach] as const,
  contacts: (q?: string) => ["crm", "contacts", q ?? ""] as const,
  contact: (id: string) => ["crm", "contact", id] as const,
  activity: (entityType: string, entityId?: string | null) =>
    entityId === undefined ? (["crm", "activity", entityType] as const) : (["crm", "activity", entityType, entityId ?? ""] as const),
  emailTemplates: (includeArchived: boolean) => ["crm", "email-templates", includeArchived] as const,
  products: (includeArchived: boolean) => ["crm", "products", includeArchived] as const,
  dealProducts: (dealId: string) => ["crm", "deal-products", dealId] as const,
  notifications: ["crm", "notifications"] as const,
  // Invalidation prefixes — match every variant of the corresponding full key.
  dealsPrefix: ["crm", "deals"] as const,
  dealPrefix: ["crm", "deal"] as const,
  companiesPrefix: ["crm", "companies"] as const,
  companyPrefix: ["crm", "company"] as const,
  contactsPrefix: ["crm", "contacts"] as const,
  tasksPrefix: ["crm", "tasks"] as const,
  notesPrefix: ["crm", "notes"] as const,
  emailTemplatesPrefix: ["crm", "email-templates"] as const,
  productsPrefix: ["crm", "products"] as const,
};

// ── Pipeline ─────────────────────────────────────────────────────────────────

export function useCrmStages() {
  return useQuery({
    queryKey: crmKeys.stages,
    queryFn: () => apiFetch<{ stages: CrmStage[] }>("/api/crm/pipeline-stages").then((r) => r.stages),
  });
}

/** Stage edits reshape the whole board, so every mutation refetches stages AND deals. */
function useInvalidatePipeline() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: crmKeys.stages });
    qc.invalidateQueries({ queryKey: crmKeys.dealsPrefix });
  };
}

export function useCreateStage() {
  const invalidate = useInvalidatePipeline();
  return useMutation({
    mutationFn: (body: { name: string; isTerminal?: boolean; terminalOutcome?: "WON" | "LOST" | null }) =>
      apiPostJson<{ stage: CrmStage }>("/api/crm/pipeline-stages", body),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not add the stage"),
  });
}

export function useUpdateStage() {
  const invalidate = useInvalidatePipeline();
  return useMutation({
    mutationFn: ({ stageId, ...body }: { stageId: string; name?: string; terminalOutcome?: "WON" | "LOST" | null }) =>
      apiPatchJson<{ stage: CrmStage }>(`/api/crm/pipeline-stages/${stageId}`, body),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update the stage"),
  });
}

export function useReorderStages() {
  const invalidate = useInvalidatePipeline();
  return useMutation({
    mutationFn: (orderedStageIds: string[]) =>
      apiPatchJson<{ stages: CrmStage[] }>("/api/crm/pipeline-stages", { orderedStageIds }),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not reorder the pipeline"),
  });
}

export function useDeleteStage() {
  const invalidate = useInvalidatePipeline();
  return useMutation({
    mutationFn: (stageId: string) => apiDelete<{ success: true }>(`/api/crm/pipeline-stages/${stageId}`),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete the stage"),
  });
}

// ── Deals ────────────────────────────────────────────────────────────────────

export function useCrmDeals(filters: CrmDealFilters = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v) qs.set(k, v);
  }
  const suffix = qs.toString() ? `?${qs}` : "";

  return useQuery({
    queryKey: crmKeys.deals(filters),
    queryFn: () => apiFetch<{ deals: CrmBoardDeal[] }>(`/api/crm/deals${suffix}`).then((r) => r.deals),
  });
}

/** One deal by id — powers the dedicated deal page. Disabled until an id is given. */
export function useCrmDeal(dealId: string | null | undefined) {
  return useQuery({
    queryKey: crmKeys.deal(dealId ?? ""),
    queryFn: () => apiFetch<{ deal: CrmBoardDeal }>(`/api/crm/deals/${dealId}`).then((r) => r.deal),
    enabled: !!dealId,
  });
}

export function useCreateDeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPostJson<{ deal: CrmBoardDeal }>("/api/crm/deals", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.dealsPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.companiesPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.companyPrefix }); // detail pages (deal list)
    },
  });
}

export function useUpdateDeal(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPatchJson<{ deal: CrmBoardDeal }>(`/api/crm/deals/${dealId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.dealsPrefix });
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
export function useMoveDealStage(filters: CrmDealFilters = {}) {
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
      qc.invalidateQueries({ queryKey: crmKeys.dealsPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.deal(dealId) });
    },
  });
}

// ── Companies ────────────────────────────────────────────────────────────────

export interface CrmCompanyFilters {
  q?: string;
  industry?: string;
  needsReview?: string;
  archived?: string;
}

export function useCrmCompanies(arg?: string | CrmCompanyFilters) {
  const filters: CrmCompanyFilters = typeof arg === "string" ? { q: arg } : arg ?? {};
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  const key = qs.toString();
  return useQuery({
    queryKey: crmKeys.companies(key),
    queryFn: () =>
      apiFetch<{ companies: CrmCompanyRow[] }>(`/api/crm/companies${key ? `?${key}` : ""}`).then((r) => r.companies),
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
      qc.invalidateQueries({ queryKey: crmKeys.companiesPrefix });
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
    // A failed create must never be a button that does nothing (CRM review M6).
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create the company"),
  });
}

export function useUpdateCompany(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPatchJson<{ company: CrmCompanyRow }>(`/api/crm/companies/${companyId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.companiesPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.company(companyId) });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update the company"),
  });
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export interface CrmTaskFilters {
  ownerId?: string;
  dueFrom?: string;
  dueTo?: string;
  archived?: string;
}

export function useCrmTasks(
  scope: "mine" | "all" = "mine",
  status: "OPEN" | "DONE" | "all" = "OPEN",
  filters: CrmTaskFilters = {},
) {
  const qs = new URLSearchParams({ scope, status });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  return useQuery({
    queryKey: [...crmKeys.tasks(scope), status, filters],
    queryFn: () => apiFetch<{ tasks: CrmTaskRow[] }>(`/api/crm/tasks?${qs}`).then((r) => r.tasks),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPostJson<{ task: CrmTaskRow }>("/api/crm/tasks", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.tasksPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.dealPrefix });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not add the task"),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, ...body }: { taskId: string } & Record<string, unknown>) =>
      apiPatchJson<{ task: CrmTaskRow }>(`/api/crm/tasks/${taskId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.tasksPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.dealPrefix });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update the task"),
  });
}

/** Archive a task (soft delete) — DELETE now archives rather than hard-deleting. */
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => apiDelete(`/api/crm/tasks/${taskId}`),
    onSuccess: (_data, taskId) => {
      qc.invalidateQueries({ queryKey: crmKeys.tasksPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.activity("TASK", taskId) });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not archive the task"),
  });
}

/** Restore an archived task. */
export function useRestoreTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => apiPatchJson(`/api/crm/tasks/${taskId}`, { archived: false }),
    onSuccess: (_data, taskId) => {
      qc.invalidateQueries({ queryKey: crmKeys.tasksPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.activity("TASK", taskId) });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not restore the task"),
  });
}

// ── Notifications (the CRM bell) ─────────────────────────────────────────────

/**
 * The caller's CRM notification feed + unread count. Polls every 30s so the
 * bell stays roughly live without a websocket; the CRM's own feed, distinct
 * from the core notification bell in the dashboard header.
 */
export function useCrmNotifications() {
  return useQuery({
    queryKey: crmKeys.notifications,
    queryFn: () =>
      apiFetch<{ notifications: CrmNotificationRow[]; unreadCount: number }>("/api/crm/notifications"),
    refetchInterval: 30_000,
  });
}

/** Mark specific notifications ({ ids }) or everything ({ all: true }) read. */
export function useMarkCrmNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean }) =>
      apiPatchJson<{ updated: number }>("/api/crm/notifications", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: crmKeys.notifications }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update notifications"),
  });
}

// ── Notes ────────────────────────────────────────────────────────────────────

export function useCrmNotes(
  // NB the filter param the route reads is `crmContactId` (NOT `contactId` — that
  // naming drift was CRM review L15; the route, this hook and the docs now agree).
  attach: { dealId?: string; companyId?: string; crmContactId?: string },
  opts: { enabled?: boolean } = {},
) {
  const qs = new URLSearchParams(
    Object.entries(attach).filter(([, v]) => !!v) as [string, string][],
  );
  const enabled = qs.toString().length > 0 && (opts.enabled ?? true);

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
      qc.invalidateQueries({ queryKey: crmKeys.notesPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.dealPrefix });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save the note"),
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (noteId: string) => apiDelete(`/api/crm/notes/${noteId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.notesPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.dealPrefix });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete the note"),
  });
}


// ── CRM contacts (business people — NOT the event HCP store) ─────────────────

export interface CrmContactFilters {
  q?: string;
  companyId?: string;
  lifecycle?: string;
  status?: string;
  /** Filter to one rep's book — "My contacts" passes the caller's own userId. */
  owner?: string;
  archived?: string;
}

export function useCrmContacts(arg?: string | CrmContactFilters) {
  const filters: CrmContactFilters = typeof arg === "string" ? { q: arg } : arg ?? {};
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  const key = qs.toString();
  return useQuery({
    queryKey: crmKeys.contacts(key),
    queryFn: () =>
      apiFetch<{ contacts: CrmContactRow[] }>(`/api/crm/contacts${key ? `?${key}` : ""}`).then((r) => r.contacts),
  });
}

export function useCrmContactDetail(crmContactId: string | null) {
  return useQuery({
    queryKey: crmKeys.contact(crmContactId ?? ""),
    queryFn: () =>
      apiFetch<{ contact: CrmContactDetail }>(`/api/crm/contacts/${crmContactId}`).then((r) => r.contact),
    enabled: !!crmContactId,
  });
}

export function useCreateCrmContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPostJson<{ contact: CrmContactRow; created: boolean }>("/api/crm/contacts", body),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: crmKeys.contactsPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.companiesPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.companyPrefix }); // detail pages (People list)
      // find-or-create: say what actually happened.
      toast[res.created ? "success" : "info"](
        res.created
          ? `Added ${res.contact.firstName} ${res.contact.lastName}`
          : `Linked to the existing contact ${res.contact.email}`,
      );
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save the contact"),
  });
}

export function useUpdateCrmContact(crmContactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPatchJson<{ contact: CrmContactRow }>(`/api/crm/contacts/${crmContactId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.contactsPrefix });
      // The detail page's own query — ["crm","contact",id] is NOT a prefix of
      // ["crm","contacts"], so without this an edit left the open page stale.
      qc.invalidateQueries({ queryKey: crmKeys.contact(crmContactId) });
      qc.invalidateQueries({ queryKey: crmKeys.companiesPrefix });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update the contact"),
  });
}

// ── Deal ↔ contacts ─────────────────────────────────────────────────────────

export function useAddDealContact(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { crmContactId: string; role?: CrmDealContactRole }) =>
      apiPostJson(`/api/crm/deals/${dealId}/contacts`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.dealsPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.deal(dealId) });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not add the contact"),
  });
}

export function useRemoveDealContact(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (crmContactId: string) =>
      apiFetch(`/api/crm/deals/${dealId}/contacts`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crmContactId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.dealsPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.deal(dealId) });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not remove the contact"),
  });
}


// ── Reports ──────────────────────────────────────────────────────────────────

export interface CrmReport {
  canSeeValues: boolean;
  pipeline: {
    stages: Array<{
      stageId: string;
      stageName: string;
      isTerminal: boolean;
      count: number;
      value: number | null;
      currency: string | null;
      mixed: boolean;
    }>;
    openCount: number;
    openValue: number | null;
    openCurrency: string | null;
    openMixed: boolean;
  };
  winLoss: {
    wonCount: number;
    lostCount: number;
    wonValue: number | null;
    lostValue: number | null;
    wonCurrency: string | null;
    lostCurrency: string | null;
    wonMixed: boolean;
    lostMixed: boolean;
    winRate: number | null;
  };
  reps: Array<{
    ownerId: string | null;
    ownerName: string;
    openCount: number;
    openValue: number | null;
    openCurrency: string | null;
    openMixed: boolean;
    wonCount: number;
    wonValue: number | null;
    wonCurrency: string | null;
    wonMixed: boolean;
  }>;
  generatedAt: string;
}

export function useCrmReport(filters: Record<string, string | undefined> = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  const key = qs.toString();
  return useQuery({
    queryKey: ["crm", "report", key],
    queryFn: () => apiFetch<CrmReport>(`/api/crm/reports${key ? `?${key}` : ""}`),
  });
}


// ── Change log (system activity) ──────────────────────────────────────────────

/** The change log for one record, newest first. Powers the History timeline. */
export function useCrmActivity(entityType: CrmActivityEntityType, entityId: string | null | undefined) {
  return useQuery({
    queryKey: crmKeys.activity(entityType, entityId ?? ""),
    queryFn: () =>
      apiFetch<{ activity: CrmActivityRow[] }>(
        `/api/crm/activity?entityType=${entityType}&entityId=${entityId}`,
      ).then((r) => r.activity),
    enabled: !!entityId,
  });
}

// ── Archive / restore (soft delete) ───────────────────────────────────────────
// A single mutation per entity: `archived: true` hits DELETE (archive), `false`
// hits PATCH { archived: false } (restore). Both invalidate the entity's lists AND
// its activity log, so the History timeline picks up the ARCHIVE/RESTORE row.

export function useSetDealArchived(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (archived: boolean) =>
      archived
        ? apiDelete(`/api/crm/deals/${dealId}`)
        : apiPatchJson(`/api/crm/deals/${dealId}`, { archived: false }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.dealsPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.deal(dealId) });
      qc.invalidateQueries({ queryKey: crmKeys.activity("DEAL", dealId) });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not archive the deal"),
  });
}

export function useSetCompanyArchived(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (archived: boolean) =>
      archived
        ? apiDelete(`/api/crm/companies/${companyId}`)
        : apiPatchJson(`/api/crm/companies/${companyId}`, { archived: false }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.companiesPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.company(companyId) });
      qc.invalidateQueries({ queryKey: crmKeys.activity("COMPANY", companyId) });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not archive the company"),
  });
}

export function useSetCrmContactArchived(crmContactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (archived: boolean) =>
      archived
        ? apiDelete(`/api/crm/contacts/${crmContactId}`)
        : apiPatchJson(`/api/crm/contacts/${crmContactId}`, { archived: false }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.contactsPrefix });
      qc.invalidateQueries({ queryKey: crmKeys.contact(crmContactId) });
      qc.invalidateQueries({ queryKey: crmKeys.activity("CONTACT", crmContactId) });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not archive the contact"),
  });
}

/**
 * Org events as {id, name} for the CRM's event pickers. Uses the CRM-gated
 * events-lite endpoint, so a CRM_USER (no event-API access) can still tag deals.
 */
export function useCrmEvents() {
  return useQuery({
    queryKey: ["crm", "events-lite"],
    queryFn: () =>
      apiFetch<{ events: Array<{ id: string; name: string }> }>("/api/crm/events-lite").then((r) => r.events),
  });
}

// ── CRM email (sponsor blast + per-deal send) ─────────────────────────────────

/** What a send targets: everyone on an event's deals, or one deal's contacts. */
export type CrmEmailTarget = { kind: "event"; id: string } | { kind: "deal"; id: string };

export interface CrmEmailRecipientsResponse {
  recipients: SponsorRecipient[];
  skipped: { noEmail: number; archivedContacts: number };
  target: { kind: "event" | "deal"; id: string; name: string };
}

export interface CrmEmailSendResult {
  total: number;
  successCount: number;
  failureCount: number;
  errors: Array<{ email: string; error: string }>;
}

/**
 * Preview who a send would reach — an event's deduped sponsor contacts, or a single
 * deal's contacts. Disabled until a target is chosen.
 */
export function useCrmEmailRecipients(target: CrmEmailTarget | null | undefined) {
  const param = target
    ? `${target.kind === "deal" ? "dealId" : "eventId"}=${encodeURIComponent(target.id)}`
    : "";
  return useQuery({
    queryKey: ["crm", "email-recipients", target?.kind ?? "", target?.id ?? ""],
    queryFn: () =>
      apiFetch<CrmEmailRecipientsResponse>(`/api/crm/sponsor-email/recipients?${param}`),
    enabled: !!target,
  });
}

/**
 * The org's reusable CRM email templates. `includeArchived` powers the "Show
 * archived" toggle on the management page; the compose picker uses the default
 * (active only). The GET seeds the built-in three on first use.
 */
export function useCrmEmailTemplates(includeArchived = false) {
  return useQuery({
    queryKey: crmKeys.emailTemplates(includeArchived),
    queryFn: () =>
      apiFetch<{ templates: CrmEmailTemplateRow[] }>(
        `/api/crm/email-templates${includeArchived ? "?archived=1" : ""}`,
      ).then((r) => r.templates),
  });
}

export function useCreateCrmEmailTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; subject: string; body: string }) =>
      apiPostJson<{ template: CrmEmailTemplateRow }>("/api/crm/email-templates", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: crmKeys.emailTemplatesPrefix }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create the template"),
  });
}

export function useUpdateCrmEmailTemplate(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; subject?: string; body?: string }) =>
      apiPatchJson<{ template: CrmEmailTemplateRow }>(`/api/crm/email-templates/${templateId}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: crmKeys.emailTemplatesPrefix }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update the template"),
  });
}

/** Archive (`true` → DELETE) or restore (`false` → PATCH) a template. */
export function useSetCrmEmailTemplateArchived(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (archived: boolean) =>
      archived
        ? apiDelete(`/api/crm/email-templates/${templateId}`)
        : apiPatchJson(`/api/crm/email-templates/${templateId}`, { archived: false }),
    onSuccess: () => qc.invalidateQueries({ queryKey: crmKeys.emailTemplatesPrefix }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not archive the template"),
  });
}

// ── Products (catalog + deal line items) ──────────────────────────────────────

export function useCrmProducts(includeArchived = false) {
  return useQuery({
    queryKey: crmKeys.products(includeArchived),
    queryFn: () =>
      apiFetch<{ products: CrmProductRow[] }>(
        `/api/crm/products${includeArchived ? "?archived=1" : ""}`,
      ).then((r) => r.products),
  });
}

export function useCreateCrmProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPostJson<{ product: CrmProductRow }>("/api/crm/products", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: crmKeys.productsPrefix }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create the product"),
  });
}

export function useUpdateCrmProduct(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPatchJson<{ product: CrmProductRow }>(`/api/crm/products/${productId}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: crmKeys.productsPrefix }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update the product"),
  });
}

export function useSetCrmProductArchived(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (archived: boolean) =>
      archived
        ? apiDelete(`/api/crm/products/${productId}`)
        : apiPatchJson(`/api/crm/products/${productId}`, { archived: false }),
    onSuccess: () => qc.invalidateQueries({ queryKey: crmKeys.productsPrefix }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not archive the product"),
  });
}

// A deal's line items.
export function useDealProducts(dealId: string) {
  return useQuery({
    queryKey: crmKeys.dealProducts(dealId),
    queryFn: () => apiFetch<{ lines: CrmDealProductRow[] }>(`/api/crm/deals/${dealId}/products`).then((r) => r.lines),
    enabled: !!dealId,
  });
}

export function useAddDealProduct(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { crmProductId: string; unitPrice?: number; quantity?: number }) =>
      apiPostJson(`/api/crm/deals/${dealId}/products`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.dealProducts(dealId) });
      qc.invalidateQueries({ queryKey: crmKeys.activity("DEAL", dealId) });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not add the product"),
  });
}

export function useUpdateDealProduct(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { lineId: string; unitPrice?: number; quantity?: number }) =>
      apiPatchJson(`/api/crm/deals/${dealId}/products`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: crmKeys.dealProducts(dealId) }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update the line item"),
  });
}

export function useRemoveDealProduct(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lineId: string) =>
      apiFetch(`/api/crm/deals/${dealId}/products`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: crmKeys.dealProducts(dealId) });
      qc.invalidateQueries({ queryKey: crmKeys.activity("DEAL", dealId) });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not remove the line item"),
  });
}

/** Send a CRM email to an event's sponsors (eventId) or one deal's contacts (dealId). */
export function useSendCrmEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      eventId?: string;
      dealId?: string;
      subject: string;
      message: string;
      contactIds?: string[];
      attachments?: { name: string; content: string; contentType?: string }[];
    }) => apiPostJson<CrmEmailSendResult>("/api/crm/sponsor-email/send", body),
    onSuccess: (_res, vars) => {
      // A send records history on each contact (and, for a deal, on the deal).
      qc.invalidateQueries({ queryKey: crmKeys.activity("CONTACT") });
      if (vars.dealId) {
        qc.invalidateQueries({ queryKey: crmKeys.activity("DEAL", vars.dealId) });
      }
    },
  });
}

// ── Purge (SUPER_ADMIN permanent delete of archived records) ─────────────────

/** Bulk-purge report shape returned by POST /api/crm/purge { scope: "all" }. */
export interface CrmPurgeAllResult {
  ok: true;
  purged: { deals: number; companies: number; contacts: number };
  skipped: Array<{ entity: "deal" | "company" | "contact"; id: string; name: string; reason: string }>;
  capped: boolean;
}

/**
 * Permanently delete ONE archived record. SUPER_ADMIN only (the server enforces
 * it). Invalidates the archived lists + the record's activity.
 */
export function usePurgeCrmRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { entity: "deal" | "company" | "contact"; id: string }) =>
      apiPostJson<{ ok: true }>("/api/crm/purge", { scope: "record", entity: vars.entity, id: vars.id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete the record"),
  });
}

/** Permanently delete EVERY archived record of a kind (or all kinds). SUPER_ADMIN only. */
export function usePurgeArchived() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entity: "deals" | "companies" | "contacts" | "all") =>
      apiPostJson<CrmPurgeAllResult>("/api/crm/purge", { scope: "all", entity }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not empty the archive"),
  });
}

/**
 * The org's deal-owning staff (sales team + admins) for the owner picker. CRM-gated
 * so a CRM_USER can populate it, and scoped to exactly the deal-owning roles.
 */
export function useCrmReps() {
  return useQuery({
    queryKey: ["crm", "reps"],
    queryFn: () =>
      apiFetch<{ reps: Array<{ id: string; firstName: string; lastName: string; role: string }> }>(
        "/api/crm/reps",
      ).then((r) => r.reps),
  });
}
