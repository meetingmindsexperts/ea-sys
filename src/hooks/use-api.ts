/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// Generic fetch wrapper with error handling.
// Automatically injects x-org-id header for SUPER_ADMIN org switching.
async function fetchApi<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  const activeOrgId = typeof window !== "undefined" ? localStorage.getItem("ea-sys:active-org-id") : null;
  if (activeOrgId) {
    headers.set("x-org-id", activeOrgId);
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }
  return res.json();
}

function buildQueryString(filters?: Record<string, string>): string {
  if (!filters) {
    return "";
  }

  const params = new URLSearchParams(filters);
  const queryString = params.toString();

  return queryString ? `?${queryString}` : "";
}

function useEventListQuery<T>(
  eventId: string,
  key: readonly unknown[],
  path: string,
  filters?: Record<string, string>
) {
  const queryString = buildQueryString(filters);

  return useQuery({
    queryKey: filters ? [...key, filters] : key,
    queryFn: () => fetchApi<T>(`/api/events/${eventId}/${path}${queryString}`),
    enabled: !!eventId,
  });
}

// Query keys for cache management
export const queryKeys = {
  orgBranding: ["org-branding"] as const,
  events: ["events"] as const,
  event: (eventId: string) => ["events", eventId] as const,
  tickets: (eventId: string) => ["events", eventId, "tickets"] as const,
  registrations: (eventId: string) => ["events", eventId, "registrations"] as const,
  speakers: (eventId: string) => ["events", eventId, "speakers"] as const,
  sessions: (eventId: string) => ["events", eventId, "sessions"] as const,
  tracks: (eventId: string) => ["events", eventId, "tracks"] as const,
  abstracts: (eventId: string) => ["events", eventId, "abstracts"] as const,
  abstractThemes: (eventId: string) => ["events", eventId, "abstract-themes"] as const,
  reviewCriteria: (eventId: string) => ["events", eventId, "review-criteria"] as const,
  eventMedia: (eventId: string) => ["events", eventId, "media"] as const,
  hotels: (eventId: string) => ["events", eventId, "hotels"] as const,
  accommodations: (eventId: string) => ["events", eventId, "accommodations"] as const,
  reviewers: (eventId: string) => ["events", eventId, "reviewers"] as const,
  contacts: ["contacts"] as const,
  contact: (contactId: string) => ["contacts", contactId] as const,
  apiKeys: ["api-keys"] as const,
  eventsAirConfig: ["eventsair", "config"] as const,
  eventsAirEvents: ["eventsair", "events"] as const,
  importLogs: (eventId: string) => ["events", eventId, "import-logs"] as const,
  emailTemplates: (eventId: string) => ["events", eventId, "email-templates"] as const,
  emailTemplate: (eventId: string, templateId: string) => ["events", eventId, "email-templates", templateId] as const,
  registrationTypes: ["registration-types"] as const,
  notifications: ["notifications"] as const,
  organizations: ["organizations"] as const,
  invoices: (eventId: string) => ["events", eventId, "invoices"] as const,
  registrationInvoices: (registrationId: string) => ["registrations", registrationId, "invoices"] as const,
  zoomCredentials: ["zoom", "credentials"] as const,
  zoomSettings: (eventId: string) => ["zoom", "settings", eventId] as const,
  zoomMeeting: (sessionId: string) => ["zoom", "meeting", sessionId] as const,
};

// ============ ORGANIZATIONS (SUPER_ADMIN) ============
export interface OrgListItem {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  primaryColor: string | null;
  _count: { events: number; users: number };
}

export function useOrganizations(enabled = false) {
  return useQuery({
    queryKey: queryKeys.organizations,
    queryFn: () => fetchApi<OrgListItem[]>("/api/organizations"),
    enabled,
    staleTime: 10 * 60 * 1000,
  });
}

// ============ ORG BRANDING ============
export interface OrgBranding {
  name: string | null;
  logo: string | null;
  primaryColor: string | null;
}

export function useOrgBranding() {
  return useQuery({
    queryKey: queryKeys.orgBranding,
    queryFn: () => fetchApi<OrgBranding>("/api/organization/branding"),
    staleTime: 10 * 60 * 1000, // 10 minutes
  });
}

// ============ EVENTS ============
export function useEvents() {
  return useQuery({
    queryKey: queryKeys.events,
    queryFn: () => fetchApi<any[]>("/api/events"),
  });
}

export function useOrgUsers() {
  return useQuery({
    queryKey: ["org-users"],
    queryFn: () => fetchApi<{ id: string; firstName: string; lastName: string; email: string; role: string }[]>("/api/organization/users"),
  });
}

export function useEvent(eventId: string) {
  return useQuery({
    queryKey: queryKeys.event(eventId),
    queryFn: () => fetchApi<any>(`/api/events/${eventId}`),
    enabled: !!eventId,
  });
}

export function useCloneEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      fetchApi<{ id: string; name: string; slug: string }>(
        `/api/events/${eventId}/clone`,
        { method: "POST" }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.events });
    },
  });
}

// ============ TICKETS ============
export function useTickets(eventId: string) {
  return useEventListQuery<any[]>(eventId, queryKeys.tickets(eventId), "tickets");
}

export function useCreateTicket(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      fetchApi(`/api/events/${eventId}/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tickets(eventId) });
    },
  });
}

export function useUpdateTicket(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, data }: { ticketId: string; data: any }) =>
      fetchApi(`/api/events/${eventId}/tickets/${ticketId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tickets(eventId) });
    },
  });
}

export function useDeleteTicket(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) =>
      fetchApi(`/api/events/${eventId}/tickets/${ticketId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tickets(eventId) });
    },
  });
}

// ============ PRICING TIERS ============
export function useCreatePricingTier(eventId: string, ticketTypeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      fetchApi(`/api/events/${eventId}/tickets/${ticketTypeId}/tiers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tickets(eventId) });
    },
  });
}

export function useUpdatePricingTier(eventId: string, ticketTypeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tierId, data }: { tierId: string; data: any }) =>
      fetchApi(`/api/events/${eventId}/tickets/${ticketTypeId}/tiers/${tierId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tickets(eventId) });
    },
  });
}

export function useDeletePricingTier(eventId: string, ticketTypeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tierId: string) =>
      fetchApi(`/api/events/${eventId}/tickets/${ticketTypeId}/tiers/${tierId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tickets(eventId) });
    },
  });
}

// ============ REGISTRATIONS ============
export function useRegistrations(eventId: string, filters?: Record<string, string>) {
  return useEventListQuery<any[]>(eventId, queryKeys.registrations(eventId), "registrations", filters);
}

// ============ SPEAKERS ============
export function useSpeakers(eventId: string) {
  return useEventListQuery<any[]>(eventId, queryKeys.speakers(eventId), "speakers");
}

export function useCreateSpeaker(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      fetchApi(`/api/events/${eventId}/speakers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.speakers(eventId) });
    },
  });
}

// ============ SESSIONS ============
export function useSessions(eventId: string, filters?: Record<string, string>) {
  return useEventListQuery<any[]>(eventId, queryKeys.sessions(eventId), "sessions", filters);
}

// ============ TRACKS ============
export function useTracks(eventId: string) {
  return useEventListQuery<any[]>(eventId, queryKeys.tracks(eventId), "tracks");
}

// ============ ABSTRACTS ============
export function useAbstracts(eventId: string, filters?: Record<string, string>) {
  return useEventListQuery<any[]>(eventId, queryKeys.abstracts(eventId), "abstracts", filters);
}

// ============ HOTELS ============
export function useHotels(eventId: string) {
  return useEventListQuery<any[]>(eventId, queryKeys.hotels(eventId), "hotels");
}

// ============ ACCOMMODATIONS ============
export function useAccommodations(eventId: string, filters?: Record<string, string>) {
  return useEventListQuery<any[]>(eventId, queryKeys.accommodations(eventId), "accommodations", filters);
}

// ============ IMPORT LOGS ============
export function useImportLogs(eventId: string) {
  return useEventListQuery<any[]>(eventId, queryKeys.importLogs(eventId), "import-logs");
}

// ============ REVIEWERS ============
export function useReviewers(eventId: string) {
  return useQuery({
    queryKey: queryKeys.reviewers(eventId),
    queryFn: () => fetchApi<any>(`/api/events/${eventId}/reviewers`),
    enabled: !!eventId,
  });
}

export function useAddReviewer(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { type: "speaker"; speakerId: string } | { type: "direct"; email: string; firstName: string; lastName: string }) =>
      fetchApi(`/api/events/${eventId}/reviewers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewers(eventId) });
    },
  });
}

export function useRemoveReviewer(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reviewerId: string) =>
      fetchApi(`/api/events/${eventId}/reviewers/${reviewerId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewers(eventId) });
    },
  });
}

// ============ CONTACTS ============
export function useContacts(filters?: Record<string, string>) {
  const queryString = buildQueryString(filters);
  return useQuery({
    queryKey: filters ? [...queryKeys.contacts, filters] : queryKeys.contacts,
    queryFn: () => fetchApi<any>(`/api/contacts${queryString}`),
  });
}

export function useContact(contactId: string) {
  return useQuery({
    queryKey: queryKeys.contact(contactId),
    queryFn: () => fetchApi<any>(`/api/contacts/${contactId}`),
    enabled: !!contactId,
  });
}

export function useCreateContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      fetchApi("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts });
    },
  });
}

export function useUpdateContact(contactId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      fetchApi(`/api/contacts/${contactId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts });
      queryClient.invalidateQueries({ queryKey: queryKeys.contact(contactId) });
    },
  });
}

export function useDeleteContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contactId: string) =>
      fetchApi(`/api/contacts/${contactId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts });
    },
  });
}

export function useContactTags() {
  return useQuery({
    queryKey: [...queryKeys.contacts, "tags"],
    queryFn: () => fetchApi<{ tags: string[] }>("/api/contacts/tags"),
  });
}

export function useUpdateContactTags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ contactId, tags }: { contactId: string; tags: string[] }) =>
      fetchApi(`/api/contacts/${contactId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts });
    },
  });
}

export function useBulkTagContacts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { contactIds: string[]; tags: string[]; mode: "add" | "remove" | "replace" }) =>
      fetchApi("/api/contacts/bulk-tags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.contacts, "tags"] });
    },
  });
}

// ============ BULK TAGS (Registrations & Speakers) ============
export function useBulkTagRegistrations(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { registrationIds: string[]; tags: string[]; mode: "add" | "remove" | "replace" }) =>
      fetchApi(`/api/events/${eventId}/registrations/bulk-tags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
    },
  });
}

export function useBulkUpdateRegistrationType(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { registrationIds: string[]; ticketTypeId: string }) =>
      fetchApi(`/api/events/${eventId}/registrations/bulk-type`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tickets(eventId) });
    },
  });
}

export function useBulkTagSpeakers(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { speakerIds: string[]; tags: string[]; mode: "add" | "remove" | "replace" }) =>
      fetchApi(`/api/events/${eventId}/speakers/bulk-tags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.speakers(eventId) });
    },
  });
}

export function useImportContactsToSpeakers(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contactIds: string[]) =>
      fetchApi(`/api/events/${eventId}/speakers/import-contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.speakers(eventId) });
    },
  });
}

export function useImportRegistrationsToSpeakers(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (registrationIds: string[]) =>
      fetchApi(`/api/events/${eventId}/speakers/import-registrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationIds }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.speakers(eventId) });
    },
  });
}

export function useImportContactsToRegistrations(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ contactIds, ticketTypeId }: { contactIds: string[]; ticketTypeId: string }) =>
      fetchApi(`/api/events/${eventId}/registrations/import-contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds, ticketTypeId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
    },
  });
}

// ============ API KEYS ============
export function useApiKeys() {
  return useQuery({
    queryKey: queryKeys.apiKeys,
    queryFn: () => fetchApi<any[]>("/api/organization/api-keys"),
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; expiresAt?: string }) =>
      fetchApi<{ key: string; prefix: string }>("/api/organization/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      fetchApi(`/api/organization/api-keys/${keyId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

// ============ EVENTSAIR ============
export function useEventsAirConfig() {
  return useQuery({
    queryKey: queryKeys.eventsAirConfig,
    queryFn: () => fetchApi<{ configured: boolean; clientId: string | null; configuredAt: string | null }>("/api/organization/eventsair/credentials"),
  });
}

export function useSaveEventsAirCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { clientId: string; clientSecret: string }) =>
      fetchApi("/api/organization/eventsair/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.eventsAirConfig });
    },
  });
}

export function useTestEventsAirConnection() {
  return useMutation({
    mutationFn: () =>
      fetchApi<{ connected: boolean; error?: string }>("/api/organization/eventsair/test-connection", {
        method: "POST",
      }),
  });
}

export function useEventsAirEvents() {
  return useQuery({
    queryKey: queryKeys.eventsAirEvents,
    queryFn: () => fetchApi<any[]>("/api/organization/eventsair/events"),
    enabled: false,
    retry: false,
  });
}

export function useImportEventsAirEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { eventsAirEventId: string }) =>
      fetchApi<{ eventId: string; alreadyImported: boolean }>("/api/import/eventsair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.events });
    },
  });
}

export function useImportEventsAirContacts(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { eventsAirEventId: string; offset?: number; limit?: number }) =>
      fetchApi<{ processed: number; created: number; skipped: number; hasMore: boolean; nextOffset: number; errors: string[] }>(
        `/api/events/${eventId}/import/eventsair`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.speakers(eventId) });
    },
  });
}

export function useImportEventsAirToContacts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { eventsAirEventId: string; offset?: number; limit?: number }) =>
      fetchApi<{ processed: number; created: number; updated: number; skipped: number; hasMore: boolean; nextOffset: number; errors: string[] }>(
        "/api/contacts/import-eventsair",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.contacts, "tags"] });
    },
  });
}

// ============ REGISTRATION TYPES ============
export function useRegistrationTypes() {
  return useQuery({
    queryKey: queryKeys.registrationTypes,
    queryFn: () => fetchApi<string[]>("/api/registration-types"),
  });
}

// ============ EMAIL TEMPLATES ============
export function useEmailTemplates(eventId: string) {
  return useQuery({
    queryKey: queryKeys.emailTemplates(eventId),
    queryFn: () =>
      fetchApi<{ templates: any[]; variables: Record<string, { key: string; description: string }[]> }>(
        `/api/events/${eventId}/email-templates`
      ),
    enabled: !!eventId,
  });
}

export function useEmailTemplate(eventId: string, templateId: string) {
  return useQuery({
    queryKey: queryKeys.emailTemplate(eventId, templateId),
    queryFn: () =>
      fetchApi<{ template: any; variables: { key: string; description: string }[] }>(
        `/api/events/${eventId}/email-templates/${templateId}`
      ),
    enabled: !!eventId && !!templateId,
  });
}

export function useUpdateEmailTemplate(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, data }: { templateId: string; data: any }) =>
      fetchApi(`/api/events/${eventId}/email-templates/${templateId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: (_, { templateId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.emailTemplates(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.emailTemplate(eventId, templateId) });
    },
  });
}

export function useResetEmailTemplate(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) =>
      fetchApi(`/api/events/${eventId}/email-templates/${templateId}`, {
        method: "PATCH",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.emailTemplates(eventId) });
    },
  });
}

export function useCreateEmailTemplate(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { slug: string; name: string; subject: string; htmlContent: string; textContent?: string }) =>
      fetchApi(`/api/events/${eventId}/email-templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.emailTemplates(eventId) });
    },
  });
}

export function useDeleteEmailTemplate(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) =>
      fetchApi(`/api/events/${eventId}/email-templates/${templateId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.emailTemplates(eventId) });
    },
  });
}

export function usePreviewEmailTemplate(eventId: string) {
  return useMutation({
    mutationFn: ({ templateId, action }: { templateId: string; action: "preview" | "test" }) =>
      fetchApi<{ subject?: string; htmlContent?: string; success?: boolean; message?: string }>(
        `/api/events/${eventId}/email-templates/${templateId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }
      ),
  });
}

// ============ BULK EMAIL ============
export function useBulkEmail(eventId: string) {
  return useMutation({
    mutationFn: (data: {
      recipientType: "speakers" | "registrations" | "reviewers" | "abstracts";
      recipientIds?: string[];
      emailType: "invitation" | "agreement" | "confirmation" | "reminder" | "custom" | "abstract-accepted" | "abstract-rejected" | "abstract-revision" | "abstract-reminder";
      customSubject?: string;
      customMessage?: string;
      attachments?: Array<{ name: string; content: string; contentType?: string }>;
      filters?: { status?: string; ticketTypeId?: string };
    }) =>
      fetchApi<{ success: boolean; message: string; stats: { total: number; sent: number; failed: number }; errors?: Array<{ email: string; error: string }> }>(
        `/api/events/${eventId}/emails/bulk`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      ),
  });
}

// ============ CSV IMPORTS ============
export function useCSVImport(eventId: string, entityType: "registrations" | "speakers" | "sessions" | "abstracts") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return fetchApi<{ created: number; skipped?: number; tracksCreated?: number; errors: string[]; registrationIds?: string[] }>(
        `/api/events/${eventId}/import/${entityType}`,
        { method: "POST", body: formData }
      );
    },
    onSuccess: () => {
      const keyMap: Record<string, readonly unknown[]> = {
        registrations: queryKeys.registrations(eventId),
        speakers: queryKeys.speakers(eventId),
        sessions: queryKeys.sessions(eventId),
        abstracts: queryKeys.abstracts(eventId),
      };
      queryClient.invalidateQueries({ queryKey: keyMap[entityType] });
    },
  });
}

export function useSendCompletionEmails(eventId: string) {
  return useMutation({
    mutationFn: (registrationIds: string[]) =>
      fetchApi<{ sent: number; skipped: number; errors: string[] }>(
        `/api/events/${eventId}/import/registrations/send-completion-emails`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registrationIds }),
        }
      ),
  });
}

// ============ NOTIFICATIONS ============
export function useNotifications() {
  return useQuery<{ notifications: any[]; unreadCount: number }>({
    queryKey: queryKeys.notifications,
    queryFn: () => fetchApi("/api/notifications"),
    refetchInterval: 30_000,
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { ids?: string[]; all?: true }) =>
      fetchApi("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
  });
}

// ============ ABSTRACT THEMES ============

export function useAbstractThemes(eventId: string) {
  return useEventListQuery<any[]>(eventId, queryKeys.abstractThemes(eventId), "abstract-themes");
}

export function useCreateAbstractTheme(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; sortOrder?: number }) =>
      fetchApi(`/api/events/${eventId}/abstract-themes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstractThemes(eventId) });
    },
  });
}

export function useUpdateAbstractTheme(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ themeId, ...data }: { themeId: string; name?: string; sortOrder?: number }) =>
      fetchApi(`/api/events/${eventId}/abstract-themes/${themeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstractThemes(eventId) });
    },
  });
}

export function useDeleteAbstractTheme(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (themeId: string) =>
      fetchApi(`/api/events/${eventId}/abstract-themes/${themeId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstractThemes(eventId) });
    },
  });
}

// ============ REVIEW CRITERIA ============

export function useReviewCriteria(eventId: string) {
  return useEventListQuery<any[]>(eventId, queryKeys.reviewCriteria(eventId), "review-criteria");
}

export function useCreateReviewCriterion(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; weight: number; sortOrder?: number }) =>
      fetchApi(`/api/events/${eventId}/review-criteria`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewCriteria(eventId) });
    },
  });
}

export function useUpdateReviewCriterion(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ criterionId, ...data }: { criterionId: string; name?: string; weight?: number; sortOrder?: number }) =>
      fetchApi(`/api/events/${eventId}/review-criteria/${criterionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewCriteria(eventId) });
    },
  });
}

export function useDeleteReviewCriterion(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (criterionId: string) =>
      fetchApi(`/api/events/${eventId}/review-criteria/${criterionId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewCriteria(eventId) });
    },
  });
}

// ============ EVENT MEDIA ============

export function useEventMedia(eventId: string) {
  return useQuery({
    queryKey: queryKeys.eventMedia(eventId),
    queryFn: () => fetchApi<{ mediaFiles: any[]; total: number; page: number; limit: number }>(`/api/events/${eventId}/media`),
    enabled: !!eventId,
  });
}

export function useUploadEventMedia(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (formData: FormData) =>
      fetchApi(`/api/events/${eventId}/media`, { method: "POST", body: formData }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.eventMedia(eventId) });
    },
  });
}

export function useDeleteEventMedia(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mediaId: string) =>
      fetchApi(`/api/events/${eventId}/media/${mediaId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.eventMedia(eventId) });
    },
  });
}

// ============ INVOICES ============

export interface InvoiceListItem {
  id: string;
  type: "INVOICE" | "RECEIPT" | "CREDIT_NOTE";
  invoiceNumber: string;
  status: string;
  issueDate: string;
  total: string;
  currency: string;
  sentAt: string | null;
  registration?: {
    id: string;
    attendee: { firstName: string; lastName: string; email: string };
  };
}

export function useInvoices(eventId: string, filters?: Record<string, string>) {
  return useEventListQuery<InvoiceListItem[]>(eventId, queryKeys.invoices(eventId), "invoices", filters);
}

export function useRegistrationInvoices(registrationId: string) {
  return useQuery({
    queryKey: queryKeys.registrationInvoices(registrationId),
    queryFn: () => fetchApi<InvoiceListItem[]>(`/api/registrant/registrations/${registrationId}/invoices`),
    enabled: !!registrationId,
  });
}

export function useCreateInvoice(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { registrationId: string; dueDate?: string }) =>
      fetchApi(`/api/events/${eventId}/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices(eventId) });
    },
  });
}

export function useResendInvoice(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invoiceId: string) =>
      fetchApi(`/api/events/${eventId}/invoices/${invoiceId}/send`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices(eventId) });
    },
  });
}

// ============ ZOOM ============

export function useZoomCredentials() {
  return useQuery({
    queryKey: queryKeys.zoomCredentials,
    queryFn: () =>
      fetchApi<{
        configured: boolean;
        accountId: string | null;
        clientId: string | null;
        configuredAt: string | null;
      }>("/api/organization/zoom/credentials"),
  });
}

export function useSaveZoomCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { accountId: string; clientId: string; clientSecret: string }) =>
      fetchApi("/api/organization/zoom/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.zoomCredentials });
    },
  });
}

export function useDeleteZoomCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchApi("/api/organization/zoom/credentials", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.zoomCredentials });
    },
  });
}

export function useTestZoomConnection() {
  return useMutation({
    mutationFn: () =>
      fetchApi<{
        success: boolean;
        error?: string;
        account?: { email: string; firstName: string; lastName: string; accountId: string };
      }>("/api/organization/zoom/test-connection", { method: "POST" }),
  });
}

export function useZoomSettings(eventId: string) {
  return useQuery({
    queryKey: queryKeys.zoomSettings(eventId),
    queryFn: () =>
      fetchApi<{
        enabled: boolean;
        defaultMeetingType: string;
        autoCreateForSessions: boolean;
      }>(`/api/events/${eventId}/zoom/settings`),
    enabled: !!eventId,
  });
}

export function useUpdateZoomSettings(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { enabled: boolean; defaultMeetingType?: string; autoCreateForSessions?: boolean }) =>
      fetchApi(`/api/events/${eventId}/zoom/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.zoomSettings(eventId) });
    },
  });
}

export function useZoomMeeting(sessionId: string) {
  return useQuery({
    queryKey: queryKeys.zoomMeeting(sessionId),
    queryFn: () =>
      fetchApi<{
        id: string;
        zoomMeetingId: string;
        meetingType: string;
        joinUrl: string;
        passcode: string | null;
        status: string;
        isRecurring: boolean;
        occurrences: unknown[] | null;
        duration: number | null;
      }>(`/api/events/placeholder/sessions/${sessionId}/zoom`),
    enabled: false, // manually triggered
  });
}

export function useCreateZoomMeeting(eventId: string, sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      meetingType?: string;
      passcode?: string;
      waitingRoom?: boolean;
      autoRecording?: string;
      syncPanelists?: boolean;
      recurrence?: {
        type: 1 | 2 | 3;
        repeat_interval: number;
        end_date_time?: string;
        end_times?: number;
      };
    }) =>
      fetchApi(`/api/events/${eventId}/sessions/${sessionId}/zoom`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.zoomMeeting(sessionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions(eventId) });
    },
  });
}

export function useDeleteZoomMeeting(eventId: string, sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchApi(`/api/events/${eventId}/sessions/${sessionId}/zoom`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.zoomMeeting(sessionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions(eventId) });
    },
  });
}

export function useSyncZoomPanelists(eventId: string, sessionId: string) {
  return useMutation({
    mutationFn: () =>
      fetchApi<{ success: boolean; count: number }>(
        `/api/events/${eventId}/sessions/${sessionId}/zoom/panelists`,
        { method: "POST" },
      ),
  });
}
