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
