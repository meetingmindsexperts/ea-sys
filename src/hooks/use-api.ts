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
  return useQuery({
    queryKey: queryKeys.tickets(eventId),
    queryFn: () => fetchApi<any[]>(`/api/events/${eventId}/tickets`),
    enabled: !!eventId,
  });
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
  const params = new URLSearchParams(filters);
  const queryString = params.toString() ? `?${params.toString()}` : "";

  return useQuery({
    queryKey: [...queryKeys.registrations(eventId), filters],
    queryFn: () => fetchApi<any[]>(`/api/events/${eventId}/registrations${queryString}`),
    enabled: !!eventId,
  });
}

// ============ SPEAKERS ============
export function useSpeakers(eventId: string) {
  return useQuery({
    queryKey: queryKeys.speakers(eventId),
    queryFn: () => fetchApi<any[]>(`/api/events/${eventId}/speakers`),
    enabled: !!eventId,
  });
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
  const params = new URLSearchParams(filters);
  const queryString = params.toString() ? `?${params.toString()}` : "";

  return useQuery({
    queryKey: [...queryKeys.sessions(eventId), filters],
    queryFn: () => fetchApi<any[]>(`/api/events/${eventId}/sessions${queryString}`),
    enabled: !!eventId,
  });
}

// ============ TRACKS ============
export function useTracks(eventId: string) {
  return useQuery({
    queryKey: queryKeys.tracks(eventId),
    queryFn: () => fetchApi<any[]>(`/api/events/${eventId}/tracks`),
    enabled: !!eventId,
  });
}

// ============ ABSTRACTS ============
export function useAbstracts(eventId: string, filters?: Record<string, string>) {
  const params = new URLSearchParams(filters);
  const queryString = params.toString() ? `?${params.toString()}` : "";

  return useQuery({
    queryKey: [...queryKeys.abstracts(eventId), filters],
    queryFn: () => fetchApi<any[]>(`/api/events/${eventId}/abstracts${queryString}`),
    enabled: !!eventId,
  });
}

// ============ HOTELS ============
export function useHotels(eventId: string) {
  return useQuery({
    queryKey: queryKeys.hotels(eventId),
    queryFn: () => fetchApi<any[]>(`/api/events/${eventId}/hotels`),
    enabled: !!eventId,
  });
}

// ============ ACCOMMODATIONS ============
export function useAccommodations(eventId: string, filters?: Record<string, string>) {
  const params = new URLSearchParams(filters);
  const queryString = params.toString() ? `?${params.toString()}` : "";

  return useQuery({
    queryKey: [...queryKeys.accommodations(eventId), filters],
    queryFn: () => fetchApi<any[]>(`/api/events/${eventId}/accommodations${queryString}`),
    enabled: !!eventId,
  });
}
