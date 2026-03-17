/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// Generic fetch wrapper with error handling
async function fetchApi<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
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
  events: ["events"] as const,
  event: (eventId: string) => ["events", eventId] as const,
  tickets: (eventId: string) => ["events", eventId, "tickets"] as const,
  registrations: (eventId: string) => ["events", eventId, "registrations"] as const,
  speakers: (eventId: string) => ["events", eventId, "speakers"] as const,
  sessions: (eventId: string) => ["events", eventId, "sessions"] as const,
  tracks: (eventId: string) => ["events", eventId, "tracks"] as const,
  abstracts: (eventId: string) => ["events", eventId, "abstracts"] as const,
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
};

// ============ EVENTS ============
export function useEvents() {
  return useQuery({
    queryKey: queryKeys.events,
    queryFn: () => fetchApi<any[]>("/api/events"),
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
      recipientType: "speakers" | "registrations" | "reviewers";
      recipientIds?: string[];
      emailType: "invitation" | "agreement" | "confirmation" | "reminder" | "custom";
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
      return fetchApi<{ created: number; skipped?: number; tracksCreated?: number; errors: string[] }>(
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
