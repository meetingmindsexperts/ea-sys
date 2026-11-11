/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useIsMutating, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import type { StoredAttachmentRef } from "@/lib/email-attachment-limits";
import { ApiError, errorMessageFor } from "@/lib/api-fetch";

import type { WebinarHandout } from "@/lib/webinar/handouts";
import type { LivePollOption, PollTally } from "@/lib/webinar/live-polls";
import type { RegistrationFormSkipReason } from "@/lib/registration-form-link";
import type { EvidenceRequestSkipReason } from "@/lib/evidence-request";
import type { DeskDaySummary } from "@/lib/desk-day-summary";
import type { DetCredentialsStatus, DetEnvironment, DetPerformanceSummary } from "@/lib/dtcm-eticket/types";
import type { DtcmSectionMapping } from "@/lib/dtcm-eticket/sections";
import type { CatalogueSettings } from "@/lib/catalogue";
import type { RecommendedFormatValue } from "@/lib/recommended-formats";

// Generic fetch wrapper with error handling.
// Automatically injects x-org-id header for SUPER_ADMIN org switching.
export async function fetchApi<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  const activeOrgId = typeof window !== "undefined" ? localStorage.getItem("ea-sys:active-org-id") : null;
  if (activeOrgId) {
    headers.set("x-org-id", activeOrgId);
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    // ApiError, not a bare Error, so the failure carries its HTTP status.
    // `ApiError extends Error` with the same `message`, so every existing
    // `catch (e) { toast.error(e.message) }` is untouched — but the global
    // handler in providers.tsx can now recognise a 401 from THIS fetcher too.
    // Without this the session-expiry redirect would have covered the CRM
    // (which uses api-fetch.ts) and silently missed the whole core dashboard.
    const data = (await res
      .json()
      .catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(errorMessageFor(res.status, data), res.status, data);
  }
  return res.json();
}

function buildQueryString(filters?: Record<string, string | string[]>): string {
  if (!filters) {
    return "";
  }

  // An array value repeats its key (`country=A&country=B`).
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
  }
  const queryString = params.toString();

  return queryString ? `?${queryString}` : "";
}

function useEventListQuery<T>(
  eventId: string,
  key: readonly unknown[],
  path: string,
  filters?: Record<string, string>,
  /** Extra gate ANDed with the eventId check. Lets a caller hold a query back
   *  until it is actually needed (e.g. a dialog that is still closed). */
  enabled = true,
) {
  const queryString = buildQueryString(filters);

  return useQuery({
    queryKey: filters ? [...key, filters] : key,
    queryFn: () => fetchApi<T>(`/api/events/${eventId}/${path}${queryString}`),
    // The eventId guard stays: on the first render it can be an empty string,
    // and `/api/events//tickets` would 404.
    enabled: !!eventId && enabled,
  });
}

// Query keys for cache management
export const queryKeys = {
  orgBranding: ["org-branding"] as const,
  catalogueSettings: ["catalogue-settings"] as const,
  events: ["events"] as const,
  event: (eventId: string) => ["events", eventId] as const,
  tickets: (eventId: string) => ["events", eventId, "tickets"] as const,
  registrations: (eventId: string) => ["events", eventId, "registrations"] as const,
  // Under registrations, so a walk-in's invalidation refreshes it too.
  deskSummary: (eventId: string, date: string) => ["events", eventId, "registrations", "desk-summary", date] as const,
  speakers: (eventId: string) => ["events", eventId, "speakers"] as const,
  sessions: (eventId: string) => ["events", eventId, "sessions"] as const,
  tracks: (eventId: string) => ["events", eventId, "tracks"] as const,
  abstracts: (eventId: string) => ["events", eventId, "abstracts"] as const,
  abstractThemes: (eventId: string) => ["events", eventId, "abstract-themes"] as const,
  sessionProposals: (eventId: string) => ["events", eventId, "session-proposals"] as const,
  sessionProposalThemes: (eventId: string) => ["events", eventId, "session-proposal-themes"] as const,
  submissionShares: (eventId: string) => ["events", eventId, "submission-shares"] as const,
  registrationViews: (eventId: string) => ["events", eventId, "registration-shares"] as const,
  submitterContext: (eventId: string) => ["events", eventId, "submitter-context"] as const,
  reviewCriteria: (eventId: string) => ["events", eventId, "review-criteria"] as const,
  myReviews: ["my-reviews"] as const,
  myReviewSummary: ["my-reviews", "summary"] as const,
  myReview: (eventId: string, abstractId: string) => ["my-reviews", eventId, abstractId] as const,
  eventMedia: (eventId: string) => ["events", eventId, "media"] as const,
  hotels: (eventId: string) => ["events", eventId, "hotels"] as const,
  accommodations: (eventId: string) => ["events", eventId, "accommodations"] as const,
  promoCodes: (eventId: string) => ["events", eventId, "promo-codes"] as const,
  reviewers: (eventId: string) => ["events", eventId, "reviewers"] as const,
  abstractReviewers: (eventId: string, abstractId: string) =>
    ["events", eventId, "abstracts", abstractId, "reviewers"] as const,
  contacts: ["contacts"] as const,
  contact: (contactId: string) => ["contacts", contactId] as const,
  billingAccounts: ["billing-accounts"] as const,
  billingAccount: (id: string) => ["billing-accounts", id] as const,
  apiKeys: ["api-keys"] as const,
  eventsAirConfig: ["eventsair", "config"] as const,
  eventsAirEvents: ["eventsair", "events"] as const,
  importLogs: (eventId: string) => ["events", eventId, "import-logs"] as const,
  emailTemplates: (eventId: string) => ["events", eventId, "email-templates"] as const,
  emailTemplate: (eventId: string, templateId: string) => ["events", eventId, "email-templates", templateId] as const,
  scheduledEmails: (eventId: string) => ["events", eventId, "scheduled-emails"] as const,
  registrationTypes: ["registration-types"] as const,
  notifications: ["notifications"] as const,
  organizations: ["organizations"] as const,
  newEventDefaults: ["organization", "new-event-defaults"] as const,
  invoices: (eventId: string) => ["events", eventId, "invoices"] as const,
  registrationInvoices: (registrationId: string) => ["registrations", registrationId, "invoices"] as const,
  zoomCredentials: ["zoom", "credentials"] as const,
  quickbooksApp: ["quickbooks", "app"] as const,
  quickbooksConnection: ["quickbooks", "connection"] as const,
  quickbooksChart: ["quickbooks", "chart"] as const,
  stripeCredentials: ["stripe", "credentials"] as const,
  dtcmEticketCredentials: ["dtcm-eticket", "credentials"] as const,
  // Deliberately NOT under ["events", id]: the settings page invalidates that
  // on every save, and each refetch here is a DET call that could unmount an
  // unsaved mapping on a transient DET error.
  dtcmEventSections: (eventId: string) => ["dtcm-eticket", "event", eventId] as const,
  dtcmRegistrationOrders: (eventId: string, registrationId: string) => ["dtcm-eticket", "registration", eventId, registrationId] as const,
  dtcmRun: (eventId: string) => ["dtcm-eticket", "run", eventId] as const,
  dtcmUnusedOrders: (eventId: string) => ["dtcm-eticket", "unused", eventId] as const,
  aiCredentials: ["ai", "credentials"] as const,
  zoomSettings: (eventId: string) => ["zoom", "settings", eventId] as const,
  zoomMeeting: (sessionId: string) => ["zoom", "meeting", sessionId] as const,
  webinar: (eventId: string) => ["events", eventId, "webinar"] as const,
  surveys: (eventId: string) => ["events", eventId, "surveys"] as const,
  webinarSequence: (eventId: string) => ["events", eventId, "webinar", "sequence"] as const,
  webinarAttendance: (eventId: string) => ["events", eventId, "webinar", "attendance"] as const,
  webinarPresence: (eventId: string) => ["events", eventId, "webinar", "presence"] as const,
  webinarStreamTimeline: (eventId: string) => ["events", eventId, "webinar", "stream-timeline"] as const,
  webinarEngagement: (eventId: string) => ["events", eventId, "webinar", "engagement"] as const,
  webinarPanelists: (eventId: string) => ["events", eventId, "webinar", "panelists"] as const,
  sponsors: (eventId: string) => ["events", eventId, "sponsors"] as const,
  sponsorTiers: ["organization", "sponsor-tiers"] as const,
  venueRooms: (eventId: string) => ["events", eventId, "venue-rooms"] as const,
  venueShareLink: (eventId: string) => ["events", eventId, "venue-share-link"] as const,
  eventTags: (eventId: string) => ["events", eventId, "tags"] as const,
  rsvpCampaigns: (eventId: string) => ["events", eventId, "rsvp-campaigns"] as const,
  dtcmPool: (eventId: string) => ["events", eventId, "dtcm-pool"] as const,
  issuedCertificates: (
    eventId: string,
    args: { registrationId?: string; speakerId?: string },
  ) =>
    [
      "events",
      eventId,
      "certificates",
      "issued",
      args.registrationId ? `r:${args.registrationId}` : `s:${args.speakerId ?? ""}`,
    ] as const,
};

// ============ ORGANIZATIONS (SUPER_ADMIN) ============
export interface OrgListItem {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  primaryColor: string | null;
  /** Modules the organisation has (module-entitlements.ts). */
  enabledModules: string[];
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

// ============ NEW EVENT DEFAULTS (per organisation) ============
/** The registration types a new event starts with (Settings → General). */
export function useDefaultRegistrationTypes() {
  return useQuery({
    queryKey: queryKeys.newEventDefaults,
    queryFn: async () => {
      const org = await fetchApi<{ settings?: { defaultRegistrationTypes?: unknown } }>("/api/organization");
      const list = org.settings?.defaultRegistrationTypes;
      return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : [];
    },
  });
}

export function useUpdateDefaultRegistrationTypes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (names: string[]) =>
      fetchApi("/api/organization", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { defaultRegistrationTypes: names } }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.newEventDefaults }),
  });
}

// ============ ORG BRANDING ============
export interface OrgBranding {
  name: string | null;
  logo: string | null;
  primaryColor: string | null;
  /** The attendee-facing brand (src/lib/public-brand.ts): what HCPs and the kiosk show. */
  publicName: string;
  publicLogo: string | null;
}

/**
 * Keyed by organisation and held until there is a signed-in session (Sep 30,
 * 2026). OrgTheme mounts this on every page, the login page included, so the
 * old single key cached the signed-out answer (all nulls) and the client-side
 * hop to the dashboard reused it for ten minutes: no logo in the sidebar and no
 * brand colour. The settings page still invalidates by the `orgBranding` prefix.
 */
export function useOrgBranding() {
  const { data: session, status } = useSession();
  const organizationId = session?.user?.organizationId ?? null;
  return useQuery({
    queryKey: [...queryKeys.orgBranding, organizationId],
    queryFn: () => fetchApi<OrgBranding>("/api/organization/branding"),
    staleTime: 10 * 60 * 1000, // 10 minutes
    enabled: status === "authenticated",
  });
}

// ============ PUBLIC CATALOGUE (Settings, Catalogue) ============
export interface CatalogueSettingsResponse {
  settings: CatalogueSettings;
  defaults: { organizationName: string; companyEmail: string | null; companyPhone: string | null };
  events: { id: string; name: string; slug: string; status: string; startDate: string; endDate: string; city: string | null; country: string | null; listed: boolean }[];
}

export function useCatalogueSettings() {
  return useQuery({
    queryKey: queryKeys.catalogueSettings,
    queryFn: () => fetchApi<CatalogueSettingsResponse>("/api/organization/catalogue"),
  });
}

export function useSaveCatalogueSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: CatalogueSettings) =>
      fetchApi<{ settings: CatalogueSettings }>("/api/organization/catalogue", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.catalogueSettings }),
  });
}

/** List or unlist one event in the catalogue (the event's own "Show in the event catalogue" switch). */
export function useSetCatalogueListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { eventId: string; listed: boolean }) =>
      fetchApi<{ eventId: string; listed: boolean }>("/api/organization/catalogue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: (_data, { eventId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.catalogueSettings });
      qc.invalidateQueries({ queryKey: queryKeys.event(eventId) });
    },
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

/**
 * The signed-in SUBMITTER's surface context for an event (submitterSource +
 * abstract/proposal counts) — feeds src/lib/submitter-surfaces.ts in the
 * sidebar and the page redirect guard. Only enabled for submitters.
 */
export function useSubmitterContext(eventId: string) {
  return useQuery({
    queryKey: queryKeys.submitterContext(eventId),
    queryFn: () =>
      fetchApi<{ submitterSource: string | null; abstractCount: number; proposalCount: number }>(
        `/api/events/${eventId}/submitter-context`,
      ),
    enabled: !!eventId,
    staleTime: 60 * 1000,
  });
}

/** What this person holds whatever their role: the sidebar's My Reviews and My abstracts links. */
export function useMyPortalSummary(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.myReviewSummary,
    queryFn: () => fetchApi<{ hasReviewWork: boolean; hasAbstracts: boolean }>("/api/my-reviews?summary=1"),
    enabled,
  });
}

export interface MyReviewCriterion {
  id: string;
  name: string;
  weight: number;
}

export type RecommendedFormat = RecommendedFormatValue;

interface MyReviewBase {
  event: { id: string; name: string; startDate: string; endDate: string };
}

export type MyReview =
  | (MyReviewBase & {
      conflict: true;
      abstract: { id: string; serialId: number | null; title: string };
    })
  | (MyReviewBase & {
      conflict: false;
      abstract: {
        id: string;
        serialId: number | null;
        title: string;
        content: string;
        status: string;
        specialty: string | null;
        presentationType: string | null;
        submittedAt: string;
        track: { name: string } | null;
        theme: { name: string } | null;
        subTheme: { name: string } | null;
        author: { firstName: string; lastName: string; jobTitle: string | null; organization: string | null; country: string | null };
        coAuthors: { firstName: string; lastName: string; jobTitle?: string; organization?: string; country?: string }[];
      };
      assignmentRole: string | null;
      canSubmit: boolean;
      /** What this event lets a reviewer recommend (recommended-formats.ts). */
      formats: RecommendedFormat[];
      criteria: MyReviewCriterion[];
      submission: {
        overallScore: number | null;
        criteriaScores: Record<string, number> | null;
        reviewNotes: string | null;
        recommendedFormat: RecommendedFormat | null;
        updatedAt: string;
        stale: boolean;
      } | null;
    });

/** One abstract for the person reviewing it. */
export function useMyReview(eventId: string, abstractId: string) {
  return useQuery({
    queryKey: queryKeys.myReview(eventId, abstractId),
    queryFn: () => fetchApi<MyReview>(`/api/my-reviews/${eventId}/${abstractId}`),
    retry: false,
  });
}

export function useSubmitMyReview(eventId: string, abstractId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      overallScore?: number;
      criteriaScores?: { criterionId: string; score: number }[];
      reviewNotes: string;
      recommendedFormat?: RecommendedFormat;
    }) =>
      fetchApi(`/api/events/${eventId}/abstracts/${abstractId}/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    // Removed, not only invalidated: reopening must never fill the form from the
    // answer before this one. The list key is a prefix of the summary too.
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.myReview(eventId, abstractId) });
      return queryClient.invalidateQueries({ queryKey: queryKeys.myReviews });
    },
  });
}

export interface CloneEventInput {
  eventId: string;
  /** Copy the speaker list (as Invited). Defaults to true on the server. */
  includeSpeakers: boolean;
  /** Copy tracks, sessions, breaks and topics. Defaults to true on the server. */
  includeAgenda: boolean;
  /** Copy certificate templates (auto-issue paused). Defaults to true on the server. */
  includeCertificates: boolean;
}

export function useCloneEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, includeSpeakers, includeAgenda, includeCertificates }: CloneEventInput) =>
      fetchApi<{ id: string; name: string; slug: string }>(
        `/api/events/${eventId}/clone`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ includeSpeakers, includeAgenda, includeCertificates }),
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.events });
    },
  });
}

// ============ TICKETS ============
export function useTickets(eventId: string, enabled = true) {
  return useEventListQuery<any[]>(eventId, queryKeys.tickets(eventId), "tickets", undefined, enabled);
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

/**
 * Aggregated tag list for an event — used by the searchable filter
 * dropdown on the registrations list page. Returns
 * `[{ tag: string, count: number }]` sorted by count desc, then by
 * tag name. Cached on the same React Query key as bulkTagRegistrations
 * invalidates, so adding tags via the bulk dialog refreshes the
 * dropdown options without a manual refetch.
 */
export function useEventTags(eventId: string, enabled = true) {
  return useQuery<{ tags: Array<{ tag: string; count: number }> }>({
    queryKey: queryKeys.eventTags(eventId),
    queryFn: () => fetchApi(`/api/events/${eventId}/tags`),
    enabled: !!eventId && enabled,
  });
}

/** The desk's day summary (desk-summary route): walk-ins by rate and cash and card per desk user. */
export type DeskSummaryResponse = DeskDaySummary & {
  date: string;
  timezone: string;
  scope: "all" | "own";
  userNames: Record<string, string>;
};

/** A cash-up reads fresh every time it opens: never served from a five-minute-old cache. */
export function useDeskSummary(eventId: string, date: string, enabled: boolean) {
  return useQuery<DeskSummaryResponse>({
    queryKey: queryKeys.deskSummary(eventId, date),
    queryFn: () => fetchApi(`/api/events/${eventId}/registrations/desk-summary?date=${encodeURIComponent(date)}`),
    enabled: !!eventId && !!date && enabled,
    staleTime: 0,
  });
}

/** One RSVP on the event, as the campaign list returns it (staff-only route). */
export interface RsvpCampaignSummary {
  id: string;
  name: string;
  isActive: boolean;
  itemCount: number;
  inviteCount: number;
  respondedCount: number;
}

/**
 * The event's RSVPs, for the bulk-email dialog's "RSVP link" picker
 * (Sep 10, 2026). The list route is denyReviewer-guarded (it exposes audience
 * sizes), which is the same population that can open the bulk-email dialog.
 */
export function useRsvpCampaigns(eventId: string, enabled = true) {
  return useQuery<{ campaigns: RsvpCampaignSummary[] }>({
    queryKey: queryKeys.rsvpCampaigns(eventId),
    queryFn: () => fetchApi(`/api/events/${eventId}/rsvp-campaigns`),
    enabled: !!eventId && enabled,
  });
}

export interface DtcmPoolCounts {
  /** Codes imported into this event's pool. */
  total: number;
  /** Pool codes a registration on this event currently holds. */
  assigned: number;
  /** Pool codes nobody holds — what the desk can still hand out. */
  spare: number;
  /**
   * Registrations holding a DTCM code that never passed through the pool.
   * The ordinary pre-event path, surfaced only so the numbers add up on screen
   * instead of looking like codes went missing.
   */
  assignedOutsidePool: number;
}

/**
 * The DTCM spare-code pool for a Dubai event.
 *
 * The route refuses any role outside `BARCODE_ROLES` with a 403, so callers
 * MUST gate the mount on `canViewEntryBarcode` rather than relying on the
 * `enabled` flag alone — otherwise a MEMBER's dashboard fires a request that
 * can only ever fail.
 */
export function useDtcmPool(eventId: string, enabled = true) {
  return useQuery<{ enabled: boolean; counts: DtcmPoolCounts | null }>({
    queryKey: queryKeys.dtcmPool(eventId),
    queryFn: () => fetchApi(`/api/events/${eventId}/dtcm-pool`),
    enabled: !!eventId && enabled,
  });
}

/**
 * Hand the next spare code to a registration (POST on the pool route). The
 * onsite desk's "Use a spare code"; the registration sheet has its own copy of
 * this call. A refusal throws an ApiError whose `code` is the pool's outcome
 * ("pool-empty", "not-applicable", "failed").
 */
export function useClaimSpareDtcmCode(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (registrationId: string) =>
      fetchApi<{ status: "assigned" | "already-has-code"; code: string }>(`/api/events/${eventId}/dtcm-pool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationId }),
      }),
    // Claimed or not, the spare count may have moved (another desk took the last one).
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dtcmPool(eventId) });
    },
  });
}

/**
 * Same shape as useEventTags but pulled from Speaker.tags. Feeds the
 * TagInput autocomplete on the speaker detail sheet + Add Speaker form
 * so operators pick from existing tags instead of typing duplicates
 * like "VIP" vs "vip".
 */
export function useEventSpeakerTags(eventId: string, enabled = true) {
  return useQuery<{ tags: Array<{ tag: string; count: number }> }>({
    queryKey: ["events", eventId, "speaker-tags"] as const,
    queryFn: () => fetchApi(`/api/events/${eventId}/speakers/tags`),
    enabled: !!eventId && enabled,
  });
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

// ============ PROMO CODES ============
export function usePromoCodes(eventId: string) {
  return useEventListQuery<any[]>(eventId, queryKeys.promoCodes(eventId), "promo-codes");
}

export function useCreatePromoCode(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      fetchApi(`/api/events/${eventId}/promo-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.promoCodes(eventId) });
    },
  });
}

export function useUpdatePromoCode(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ promoCodeId, data }: { promoCodeId: string; data: Record<string, unknown> }) =>
      fetchApi(`/api/events/${eventId}/promo-codes/${promoCodeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.promoCodes(eventId) });
    },
  });
}

export function useDeletePromoCode(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (promoCodeId: string) =>
      fetchApi(`/api/events/${eventId}/promo-codes/${promoCodeId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.promoCodes(eventId) });
    },
  });
}

// ============ IMPORT LOGS ============
export function useImportLogs(eventId: string) {
  return useEventListQuery<any[]>(eventId, queryKeys.importLogs(eventId), "import-logs");
}

// ============ REVIEWERS ============
/**
 * The reviewer pool. Staff-only on the server (`denyReviewer`), so pass
 * `{ enabled: false }` from any surface that may render for a restricted role
 * — a React hook cannot sit behind a role early-return, so without this the
 * fetch fires and 403s before the component decides not to render.
 */
export function useReviewers(eventId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.reviewers(eventId),
    queryFn: () => fetchApi<any>(`/api/events/${eventId}/reviewers`),
    enabled: !!eventId && (options?.enabled ?? true),
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
      fetchApi<{ success: boolean; assignmentsRemoved: number }>(`/api/events/${eventId}/reviewers/${reviewerId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewers(eventId) });
      // Their assignments went too: the abstracts and each one's Reviewers card.
      queryClient.invalidateQueries({ queryKey: ["events", eventId, "abstracts"] });
    },
  });
}

export function useResendReviewerInvitation(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reviewerId: string) =>
      fetchApi<{ success: boolean; sent: boolean; type: "setup" | "portal" }>(
        `/api/events/${eventId}/reviewers/${reviewerId}/resend-invitation`,
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewers(eventId) });
    },
  });
}

/** One request's answer from the send-invitations route. */
interface SendInvitationsRound {
  emailed: number;
  failed: number;
  remaining: number;
  nextAfter: string | null;
  results: { reviewerId: string; ok: boolean; kind?: string; message?: string }[];
}

/** What one press of Send to all came to, over all its requests. */
export interface SendInvitationsOutcome {
  emailed: number;
  failed: number;
  firstFailure: string | null;
  /** A later request failed: what went is counted above, the rest were not emailed. */
  interrupted: string | null;
  /** Who was emailed and whose email was refused, so the page can NAME the rest. */
  emailedIds: string[];
  failedIds: string[];
}

/** Far more than any committee needs; a guard against a loop that never ends. */
const MAX_SEND_ROUNDS = 40;

/**
 * The server sends for about 30 seconds per request (its gateway cuts a
 * response at 60) and answers where to carry on, so a large committee is
 * several requests behind one press.
 */
async function sendInvitationsInRounds(eventId: string): Promise<SendInvitationsOutcome> {
  const total: SendInvitationsOutcome = { emailed: 0, failed: 0, firstFailure: null, interrupted: null, emailedIds: [], failedIds: [] };
  let after: string | null = null;
  for (let round = 0; round < MAX_SEND_ROUNDS; round++) {
    let page: SendInvitationsRound;
    try {
      page = await fetchApi<SendInvitationsRound>(`/api/events/${eventId}/reviewers/send-invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(after ? { after } : {}),
      });
    } catch (err) {
      // Nothing went at all: let the caller show the error.
      if (round === 0) throw err;
      total.interrupted = err instanceof Error ? err.message : "The send stopped";
      return total;
    }
    total.emailed += page.emailed;
    total.failed += page.failed;
    total.firstFailure ??= page.results.find((r) => !r.ok)?.message ?? null;
    for (const r of page.results) (r.ok ? total.emailedIds : total.failedIds).push(r.reviewerId);
    if (!page.nextAfter) return total;
    after = page.nextAfter;
  }
  total.interrupted = "The send is taking unusually long";
  return total;
}

/** Send to all: the reviewer invitation to everyone on the event's pool. */
export function useSendReviewerInvitations(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => sendInvitationsInRounds(eventId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewers(eventId) });
    },
  });
}

// ── Per-abstract reviewer assignments ──────────────────────────────────────

export type AbstractReviewerRole = "PRIMARY" | "SECONDARY" | "CONSULTING";

export interface AbstractReviewerRow {
  assignmentId: string;
  role: AbstractReviewerRole;
  assignedAt: string;
  conflictFlag: boolean;
  user: { id: string; firstName: string; lastName: string; email: string };
  hasSubmitted: boolean;
  submission: { id: string; overallScore: number | null; submittedAt: string; updatedAt: string } | null;
}

/**
 * Reviewer assignments on one abstract. Staff-only on the server (blind
 * review), so pass `{ enabled: false }` from any surface that may render for a
 * restricted role. See the note on `useReviewers`.
 */
export function useAbstractReviewers(
  eventId: string,
  abstractId: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: queryKeys.abstractReviewers(eventId, abstractId),
    queryFn: () =>
      fetchApi<{ reviewers: AbstractReviewerRow[]; total: number }>(
        `/api/events/${eventId}/abstracts/${abstractId}/reviewers`,
      ),
    enabled: !!eventId && !!abstractId && (options?.enabled ?? true),
  });
}

export function useAssignAbstractReviewer(eventId: string, abstractId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { userId: string; role?: AbstractReviewerRole; conflictFlag?: boolean }) =>
      fetchApi(`/api/events/${eventId}/abstracts/${abstractId}/reviewers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstractReviewers(eventId, abstractId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      // The Reviewers page counts each reviewer's assignments.
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewers(eventId) });
    },
  });
}

export function useUnassignAbstractReviewer(eventId: string, abstractId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      fetchApi(`/api/events/${eventId}/abstracts/${abstractId}/reviewers/${userId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstractReviewers(eventId, abstractId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      // The Reviewers page counts each reviewer's assignments.
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewers(eventId) });
    },
  });
}

// ============ CONTACTS ============
export function useContacts(filters?: Record<string, string | string[]>) {
  const queryString = buildQueryString(filters);
  return useQuery({
    queryKey: filters ? [...queryKeys.contacts, filters] : queryKeys.contacts,
    queryFn: () => fetchApi<any>(`/api/contacts${queryString}`),
  });
}

// ── Billing accounts ("charge to another account" payers) ──────────────────

/**
 * Shape returned by `GET /api/billing-accounts` (list endpoint). Mirrors the
 * Prisma `BillingAccount` columns + the `_count` aggregate the route includes.
 * Surfaced so pickers (Add Registration form, detail-sheet reassign) can drop
 * the `as { id; name; type }[]` casts and consume the hook directly.
 */
export interface BillingAccountRow {
  id: string;
  organizationId: string;
  name: string;
  type: "INSTITUTION" | "COMPANY" | "OTHER";
  email: string | null;
  phone: string | null;
  contactName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
  taxNumber: string | null;
  notes: string | null;
  isActive: boolean;
  needsReview: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { registrations: number; events?: number };
}

/**
 * Shape returned by `GET /api/billing-accounts/[id]` (detail endpoint).
 * Extends the row with the AR view + the per-event junction memberships
 * (powers the Settings → Billing "Events" attach/detach dialog).
 */
export interface BillingAccountDetail extends BillingAccountRow {
  registrations: Array<{
    id: string;
    status: string;
    paymentStatus: string;
    payerReference: string | null;
    attendeeIsGuarantor: boolean;
    createdAt: string;
    attendee: { firstName: string; lastName: string; email: string };
    event: { id: string; name: string };
    ticketType: { name: string } | null;
  }>;
  registrationCount: number;
  attachedEvents: Array<{
    eventId: string;
    addedAt: string;
    event: { id: string; name: string; startDate: string; status: string };
  }>;
}

// Pass `{ eventId }` to filter by per-event scoping (junction membership).
// Omit `eventId` for the org-wide Settings view.
/** `enabled` false skips the request for someone without `billingAccounts.read`. */
export function useBillingAccounts(params?: Record<string, string>, enabled = true) {
  const queryString = buildQueryString(params);
  return useQuery({
    queryKey: params ? [...queryKeys.billingAccounts, params] : queryKeys.billingAccounts,
    queryFn: () => fetchApi<BillingAccountRow[]>(`/api/billing-accounts${queryString}`),
    enabled,
  });
}

// Attach/detach a BillingAccount to an Event via the junction. Idempotent
// on both sides. Invalidates both the org-wide and per-event picker
// queries so the UI reflects the change immediately.
export function useAttachBillingAccountToEvent(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (billingAccountId: string) =>
      fetchApi(`/api/events/${eventId}/billing-accounts/${billingAccountId}`, {
        method: "POST",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.billingAccounts }),
  });
}

export function useDetachBillingAccountFromEvent(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (billingAccountId: string) =>
      fetchApi(`/api/events/${eventId}/billing-accounts/${billingAccountId}`, {
        method: "DELETE",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.billingAccounts }),
  });
}

/**
 * Create-or-reuse a payer at the org level (exact-name reuse; near-dup flagged)
 * AND auto-attach it to this event — the inline "+ New payer" path from the
 * registration Charge-to picker. Returns { billingAccount, reused, needsReview }.
 */
export function useCreateAndAttachBillingAccount(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      fetchApi<{ billingAccount: { id: string; name: string }; reused: boolean; needsReview: boolean }>(
        `/api/events/${eventId}/billing-accounts`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.billingAccounts }),
  });
}

export function useBillingAccount(id: string) {
  return useQuery({
    queryKey: queryKeys.billingAccount(id),
    queryFn: () => fetchApi<BillingAccountDetail>(`/api/billing-accounts/${id}`),
    enabled: !!id,
  });
}

export function useCreateBillingAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      fetchApi("/api/billing-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.billingAccounts }),
  });
}

export function useUpdateBillingAccount(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      fetchApi(`/api/billing-accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.billingAccounts });
      queryClient.invalidateQueries({ queryKey: queryKeys.billingAccount(id) });
    },
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
    // `usage` is frequency-ordered and additive — the three existing callers
    // read `tags` (distinct, alphabetical) and are unaffected.
    queryFn: () =>
      fetchApi<{ tags: string[]; usage?: { tag: string; count: number }[] }>("/api/contacts/tags"),
  });
}

export interface ContactFilterOptions {
  /** Every contact in the organisation, for "of N" beside a filtered count. */
  total: number;
  specialties: { value: string; count: number }[];
  specialtyNotSet: number;
  countries: { value: string; count: number }[];
  countryNotSet: number;
  roles: { value: string; count: number }[];
  roleNotSet: number;
}

/**
 * Choices (with counts) for the Contacts page's Specialty, Country and Role
 * filters. Each picker's counts follow the other filters, so the page's filter
 * params are part of the key; the previous choices stay on screen while the
 * next set loads instead of the pickers emptying.
 */
export function useContactFilterOptions(filters: Record<string, string | string[]>) {
  const qs = buildQueryString(filters);
  return useQuery({
    queryKey: [...queryKeys.contacts, "filter-options", filters],
    queryFn: () => fetchApi<ContactFilterOptions>(`/api/contacts/filter-options${qs}`),
    placeholderData: (previous) => previous,
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
      // Also refresh the aggregated tag list — adding a brand-new tag
      // via the bulk dialog should make it appear in the filter
      // dropdown without a page reload.
      queryClient.invalidateQueries({ queryKey: queryKeys.eventTags(eventId) });
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
      // Refresh the aggregated speaker tags so the autocomplete on
      // detail-sheet / Add Speaker forms picks up new tags
      // immediately. Symmetric with the registrations bulk-tag hook.
      queryClient.invalidateQueries({ queryKey: ["events", eventId, "speaker-tags"] });
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
    mutationFn: ({ contactIds, ticketTypeId, pricingTierId }: { contactIds: string[]; ticketTypeId?: string; pricingTierId?: string }) =>
      fetchApi(`/api/events/${eventId}/registrations/import-contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds, ticketTypeId, pricingTierId }),
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

/** The roles an API key may act with (custom roles Phase 5); `usable` is false for a role wider than you. */
export function useApiKeyRoles(enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.apiKeys, "roles"] as const,
    queryFn: () => fetchApi<{ id: string; name: string; description: string | null; usable: boolean }[]>("/api/organization/api-keys/roles"),
    enabled,
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; expiresAt?: string; rateLimitTier?: "NORMAL" | "INTERNAL"; permissionSetId?: string | null }) =>
      fetchApi<{ key: string; prefix: string; rateLimitTier: "NORMAL" | "INTERNAL" }>(
        "/api/organization/api-keys",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      ),
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

// ============ OAUTH CLIENTS (claude.ai web etc.) ============
export interface OAuthClientRow {
  clientId: string;
  clientName: string | null;
  rateLimitTier: "NORMAL" | "INTERNAL";
  createdAt: string;
  activeTokenCount: number;
  revokedTokenCount: number;
  lastUsedAt: string | null;
  users: Array<{ id: string; name: string; email: string }>;
}

export function useOAuthClients() {
  return useQuery({
    queryKey: ["oauth-clients"],
    queryFn: () => fetchApi<OAuthClientRow[]>("/api/organization/oauth-clients"),
  });
}

export function useUpdateOAuthClientTier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, rateLimitTier }: { clientId: string; rateLimitTier: "NORMAL" | "INTERNAL" }) =>
      fetchApi<{ clientId: string; rateLimitTier: "NORMAL" | "INTERNAL" }>(
        `/api/organization/oauth-clients/${encodeURIComponent(clientId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rateLimitTier }),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth-clients"] });
    },
  });
}

// ============ EVENTSAIR ============
/** `enabled`: the import dialogs ask only once opened, so a page that merely
 *  mounts a closed dialog never requests credentials it may not read. */
export function useEventsAirConfig(enabled = true) {
  return useQuery({
    queryKey: queryKeys.eventsAirConfig,
    enabled,
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
export function useEmailTemplates(eventId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.emailTemplates(eventId),
    queryFn: () =>
      fetchApi<{ templates: any[]; variables: Record<string, { key: string; description: string }[]> }>(
        `/api/events/${eventId}/email-templates`
      ),
    enabled: !!eventId && enabled,
  });
}

export function useEmailTemplate(eventId: string, templateId: string) {
  return useQuery({
    queryKey: queryKeys.emailTemplate(eventId, templateId),
    queryFn: () =>
      fetchApi<{
        template: any;
        /** Advertised in the editor's Variables panel. */
        variables: { key: string; description: string }[];
        /** The wider set the save-time token check runs against. */
        allowedTokens: string[];
        /** Custom templates only: the tokens grouped by the audience that fills them. */
        variableGroups?: { label: string; hint: string; variables: { key: string; description: string }[] }[];
      }>(`/api/events/${eventId}/email-templates/${templateId}`),
    enabled: !!eventId && !!templateId,
  });
}

export function useUpdateEmailTemplate(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, data }: { templateId: string; data: any }) =>
      // `unfillableTokens`: tokens the saved template uses that its senders do
      // not fill, so a send would be refused. Recomputed server-side after
      // token normalization.
      fetchApi<{ unfillableTokens?: string[] }>(`/api/events/${eventId}/email-templates/${templateId}`, {
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

/** Copy a template as a new custom one that starts disabled (Sep 25, 2026); returns the new row. */
export function useDuplicateEmailTemplate(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) =>
      fetchApi<{ id: string; name: string; slug: string; unfillableTokens?: string[] }>(
        `/api/events/${eventId}/email-templates/${templateId}/duplicate`,
        { method: "POST" },
      ),
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

export function usePreviewEmailBySlug(eventId: string) {
  return useMutation({
    mutationFn: (params: {
      slug: string;
      customSubject?: string;
      customMessage?: string;
      /** slug === "certificate" only — the selected CertificateTemplate ids. */
      certificateTemplateIds?: string[];
      /** Target speaker — preview greets THEM with THEIR presentation context. */
      speakerId?: string;
      /** Target registration — preview greets the registrant (title-prefixed) with their Registration #. */
      registrationId?: string;
      /** Target abstract — the resend-confirmation preview renders that abstract's real number/title/theme. */
      abstractId?: string;
    }) =>
      fetchApi<{ subject: string; htmlContent: string }>(
        `/api/events/${eventId}/email-preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        }
      ),
  });
}

// ============ BULK EMAIL ============
/**
 * Server-side audience count for an abstracts bulk send (review HIGH 1, Sep 9,
 * 2026): the same resolver the send uses, so drafts staff cannot list are still
 * counted. Only fetched while the dialog is open.
 */
export function useBulkEmailAudienceCount(
  eventId: string,
  args: { recipientType: "abstracts"; emailType: string; status?: string; recipientIds?: string[] },
  enabled: boolean,
) {
  const q = new URLSearchParams({ recipientType: args.recipientType, emailType: args.emailType });
  if (args.status && args.status !== "all") q.set("status", args.status);
  if (args.recipientIds?.length) q.set("recipientIds", args.recipientIds.join(","));
  const qs = q.toString();
  return useQuery({
    queryKey: ["bulk-email-audience-count", eventId, qs],
    queryFn: () => fetchApi<{ count: number }>(`/api/events/${eventId}/emails/audience-count?${qs}`),
    enabled: enabled && !!eventId && !!args.emailType,
    // A contradiction between type and status is a 400 the dialog already
    // prevents; never hammer it.
    retry: false,
    staleTime: 15_000,
  });
}

export function useBulkEmail(eventId: string) {
  return useMutation({
    mutationFn: (data: {
      recipientType: "speakers" | "registrations" | "reviewers" | "abstracts";
      recipientIds?: string[];
      // Matches bulkEmailSchema.emailType — includes "template" (saved custom
      // template), "survey-invitation", and the webinar-* types. Kept as a
      // permissive string (like useScheduleBulkEmail) so the dialog doesn't
      // have to re-enumerate the union here.
      emailType: string;
      customSubject?: string;
      customMessage?: string;
      /** Storage references minted by /email-attachments (Sep 8, 2026), never bytes. */
      attachments?: StoredAttachmentRef[];
      filters?: Record<string, unknown>;
    }) =>
      // Immediate send now ENQUEUES (202) and returns a job id; the
      // scheduled-emails worker drains it within ~60s. The caller polls
      // status via the Scheduled Emails list.
      fetchApi<{ success: boolean; message: string; queued: boolean; jobId: string; status: string }>(
        `/api/events/${eventId}/emails/bulk`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      ),
  });
}

// ============ SCHEDULED EMAILS ============
export interface ScheduledEmailItem {
  id: string;
  recipientType: "speakers" | "registrations" | "reviewers" | "abstracts";
  /**
   * Explicitly-selected recipient ids. Empty = filter-based send (audience
   * re-evaluated at fire time, so it includes registrations added after the
   * email was scheduled). Non-empty = fixed snapshot of exactly these rows.
   */
  recipientIds: string[];
  emailType: string;
  customSubject: string | null;
  customMessage: string | null;
  filters: { status?: string; ticketTypeId?: string } | null;
  scheduledFor: string;
  status: "PENDING" | "PROCESSING" | "SENT" | "FAILED" | "CANCELLED";
  sentAt: string | null;
  successCount: number | null;
  failureCount: number | null;
  totalCount: number | null;
  lastError: string | null;
  retryCount: number;
  createdAt: string;
  createdBy: { firstName: string; lastName: string; email: string } | null;
}

export function useScheduledEmails(eventId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.scheduledEmails(eventId),
    queryFn: () =>
      fetchApi<{ scheduledEmails: ScheduledEmailItem[] }>(
        `/api/events/${eventId}/emails/schedule`
      ).then((d) => d.scheduledEmails),
    enabled: !!eventId && enabled,
    // Poll every 15s while there are in-flight rows so the UI reflects the
    // cron worker's progress without forcing the user to refresh. Idle when
    // every row is in a terminal state (SENT/FAILED/CANCELLED).
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.length === 0) return false;
      const hasActive = data.some((r) => r.status === "PENDING" || r.status === "PROCESSING");
      return hasActive ? 15_000 : false;
    },
  });
}

export function useScheduleBulkEmail(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      recipientType: "speakers" | "registrations" | "reviewers" | "abstracts";
      recipientIds?: string[];
      emailType: string;
      customSubject?: string;
      customMessage?: string;
      /** Storage references minted by /email-attachments (Sep 8, 2026), never bytes. */
      attachments?: StoredAttachmentRef[];
      filters?: { status?: string; ticketTypeId?: string };
      scheduledFor: string; // ISO datetime
    }) =>
      fetchApi<{ success: boolean; scheduledEmail: ScheduledEmailItem }>(
        `/api/events/${eventId}/emails/schedule`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledEmails(eventId) });
    },
  });
}

export function useUpdateScheduledEmail(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: string;
      customSubject?: string | null;
      customMessage?: string | null;
      scheduledFor?: string;
    }) =>
      fetchApi<{ success: boolean; scheduledEmail: ScheduledEmailItem }>(
        `/api/events/${eventId}/emails/schedule/${id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledEmails(eventId) });
    },
  });
}

export function useCancelScheduledEmail(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetchApi<{ success: boolean }>(
        `/api/events/${eventId}/emails/schedule/${id}`,
        { method: "DELETE" }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledEmails(eventId) });
    },
  });
}

export function useRetryScheduledEmail(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetchApi<{ success: boolean; scheduledEmail: ScheduledEmailItem }>(
        `/api/events/${eventId}/emails/schedule/${id}/retry`,
        { method: "POST" }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledEmails(eventId) });
    },
  });
}

// ============ CSV IMPORTS ============
export function useCSVImport(eventId: string, entityType: "registrations" | "speakers" | "sessions" | "abstracts") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, defaultTicketTypeId, updateExisting }: { file: File; defaultTicketTypeId?: string | null; updateExisting?: boolean }) => {
      const formData = new FormData();
      formData.append("file", file);
      // Speakers and registrations: update people already on the event with
      // the file's filled cells instead of skipping them (Oct 2, 2026).
      if (updateExisting) formData.append("updateExisting", "true");
      // Registrations only: the organizer's fallback registration type for rows
      // whose `registrationType` cell is blank. Omitted ⇒ those rows import
      // uncategorised (the server never picks one for them).
      if (defaultTicketTypeId) formData.append("defaultTicketTypeId", defaultTicketTypeId);
      // `uncategorised` = rows imported with no registration type (registrations
      // entity only) — the dialog surfaces it as the cue to send completion forms.
      return fetchApi<{ created: number; updated?: number; unchanged?: number; skipped?: number; skippedRows?: string[]; updatedRows?: string[]; tracksCreated?: number; uncategorised?: number; errors: string[]; registrationIds?: string[] }>(
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { registrationIds: string[]; rate: string; sponsorId?: string; expiryDays: number }) =>
      fetchApi<{
        sent: number;
        skipped: number;
        skippedDetails: { registrationId: string; email: string | null; reason: RegistrationFormSkipReason }[];
        errors: string[];
        rateName: string;
        rateClosesAt: string | null;
      }>(
        `/api/events/${eventId}/import/registrations/send-completion-emails`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }
      ),
    // The send stamps the rate on each registration, so the list changes.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
    },
  });
}

/** Request ID and document: each person's own link (src/lib/evidence-request.ts). */
export function useSendEvidenceRequests(eventId: string) {
  return useMutation({
    mutationFn: (input: { registrationIds: string[]; expiryDays: number }) =>
      fetchApi<{
        sent: number;
        skipped: number;
        skippedDetails: { registrationId: string; reason: EvidenceRequestSkipReason }[];
        errors: string[];
      }>(`/api/events/${eventId}/registrations/evidence-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
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

// ── Sub-themes ──────────────────────────────────────────────────────────────
// No list hook: sub-themes ride nested inside useAbstractThemes, so both the
// picker and the management dialog read one source. These three invalidate that
// same query, which is why an added sub-theme appears in the dropdown at once.

export function useCreateAbstractSubTheme(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ themeId, name }: { themeId: string; name: string }) =>
      fetchApi(`/api/events/${eventId}/abstract-themes/${themeId}/sub-themes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstractThemes(eventId) });
    },
  });
}

export function useUpdateAbstractSubTheme(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ themeId, subThemeId, ...data }: { themeId: string; subThemeId: string; name?: string; sortOrder?: number }) =>
      fetchApi(`/api/events/${eventId}/abstract-themes/${themeId}/sub-themes/${subThemeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstractThemes(eventId) });
    },
  });
}

export function useDeleteAbstractSubTheme(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ themeId, subThemeId }: { themeId: string; subThemeId: string }) =>
      fetchApi(`/api/events/${eventId}/abstract-themes/${themeId}/sub-themes/${subThemeId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstractThemes(eventId) });
    },
  });
}

// ============ SESSION PROPOSALS ============

export function useSessionProposals(eventId: string) {
  return useEventListQuery<any[]>(eventId, queryKeys.sessionProposals(eventId), "session-proposals");
}

export function useCreateSessionProposal(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      speakerId: string;
      title: string;
      description: string;
      themeId?: string;
      proposedFormat?: string;
      durationMinutes?: number;
      status?: "DRAFT" | "SUBMITTED";
    }) =>
      fetchApi(`/api/events/${eventId}/session-proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessionProposals(eventId) });
    },
  });
}

export function useUpdateSessionProposal(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ proposalId, ...data }: { proposalId: string } & Record<string, unknown>) =>
      fetchApi(`/api/events/${eventId}/session-proposals/${proposalId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessionProposals(eventId) });
    },
  });
}

export function useDeleteSessionProposal(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) =>
      fetchApi(`/api/events/${eventId}/session-proposals/${proposalId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessionProposals(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessionProposalThemes(eventId) });
    },
  });
}

export function useSessionProposalThemes(eventId: string) {
  return useEventListQuery<any[]>(eventId, queryKeys.sessionProposalThemes(eventId), "session-proposal-themes");
}

// ── Shared submission views (docs/SUBMISSION_SHARE_PLAN.md) ──────────────

export interface SubmissionShareLinkView {
  kind: "ABSTRACTS" | "SESSION_PROPOSALS";
  exists: boolean;
  enabled: boolean;
  statuses: string[];
  fields: string[];
  path: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
}

export function useSubmissionShares(eventId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.submissionShares(eventId),
    queryFn: () => fetchApi<{ links: SubmissionShareLinkView[] }>(`/api/events/${eventId}/submission-shares`).then((r) => r.links),
    enabled: !!eventId && enabled,
    staleTime: 0,
  });
}

export function useSaveSubmissionShare(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { kind: SubmissionShareLinkView["kind"]; enabled: boolean; statuses: string[]; fields: string[] }) =>
      fetchApi<{ links: SubmissionShareLinkView[] }>(`/api/events/${eventId}/submission-shares`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: (r) => queryClient.setQueryData(queryKeys.submissionShares(eventId), r.links),
  });
}

export function useRegenerateSubmissionShare(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (kind: SubmissionShareLinkView["kind"]) =>
      fetchApi<{ links: SubmissionShareLinkView[] }>(`/api/events/${eventId}/submission-shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, action: "regenerate" }),
      }),
    onSuccess: (r) => queryClient.setQueryData(queryKeys.submissionShares(eventId), r.links),
  });
}

// ── Shared registration views (docs/REGISTRATION_SHARE_PLAN.md) ──────────

export interface RegistrationViewData {
  id: string;
  label: string;
  enabled: boolean;
  expiresAt: string | null;
  expired: boolean;
  statuses: string[];
  fields: string[];
  ticketTypeIds: string[];
  sponsorIds: string[];
  promoCodeIds: string[];
  includeFaculty: boolean;
  path: string;
  updatedAt: string;
  updatedByName: string | null;
}

export interface RegistrationViewsResponse {
  views: RegistrationViewData[];
  options: {
    ticketTypes: { id: string; name: string }[];
    sponsors: { id: string; name: string }[];
    promoCodes: { id: string; code: string }[];
  };
}

export type RegistrationViewBody = Omit<RegistrationViewData, "id" | "expired" | "path" | "updatedAt" | "updatedByName">;

export function useRegistrationViews(eventId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.registrationViews(eventId),
    queryFn: () => fetchApi<RegistrationViewsResponse>(`/api/events/${eventId}/registration-shares`),
    enabled: !!eventId && enabled,
    staleTime: 0,
  });
}

/** Create / update / regenerate / delete: each answers with the fresh list, which replaces the cache. */
export function useRegistrationViewMutation(eventId: string) {
  const queryClient = useQueryClient();
  const base = `/api/events/${eventId}/registration-shares`;
  const json = { "Content-Type": "application/json" };
  return useMutation({
    mutationFn: (
      op:
        | { action: "create"; body: RegistrationViewBody }
        | { action: "update"; id: string; body: RegistrationViewBody }
        | { action: "regenerate"; id: string }
        | { action: "delete"; id: string },
    ) => {
      switch (op.action) {
        case "create":
          return fetchApi<RegistrationViewsResponse & { id: string }>(base, { method: "POST", headers: json, body: JSON.stringify(op.body) });
        case "update":
          return fetchApi<RegistrationViewsResponse>(`${base}/${op.id}`, { method: "PUT", headers: json, body: JSON.stringify(op.body) });
        case "regenerate":
          return fetchApi<RegistrationViewsResponse>(`${base}/${op.id}/regenerate`, { method: "POST" });
        case "delete":
          return fetchApi<RegistrationViewsResponse>(`${base}/${op.id}`, { method: "DELETE" });
      }
    },
    onSuccess: (r) => queryClient.setQueryData(queryKeys.registrationViews(eventId), { views: r.views, options: r.options }),
  });
}

export function useCreateSessionProposalTheme(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; sortOrder?: number }) =>
      fetchApi(`/api/events/${eventId}/session-proposal-themes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessionProposalThemes(eventId) });
    },
  });
}

export function useUpdateSessionProposalTheme(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ themeId, ...data }: { themeId: string; name?: string; sortOrder?: number }) =>
      fetchApi(`/api/events/${eventId}/session-proposal-themes/${themeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessionProposalThemes(eventId) });
    },
  });
}

export function useDeleteSessionProposalTheme(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (themeId: string) =>
      fetchApi(`/api/events/${eventId}/session-proposal-themes/${themeId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessionProposalThemes(eventId) });
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
  } | null;
  /** Consolidated group invoice — bill-to is the payer (registration null). */
  group?: {
    coordinatorName: string;
    coordinatorEmail: string;
    billingAccount: { name: string; email: string | null };
  } | null;
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

/** Re-send the combined invoice + receipt packet (one email) for a registration. */
export function useResendRegistrationDocuments(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (registrationId: string) =>
      fetchApi(`/api/events/${eventId}/registrations/${registrationId}/documents/resend`, { method: "POST" }) as Promise<{
        success: boolean; message: string; invoiceNumber: string; receiptNumber: string;
      }>,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices(eventId) });
    },
  });
}

// ============ QUICKBOOKS ============

export interface QuickBooksConnectionView {
  connected: boolean;
  realmId: string | null;
  environment: "sandbox" | "production" | null;
  companyName: string | null;
  connectedAt: string | null;
  connectedByUserId: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  lastHealthCheckAt: string | null;
  lastHealthCheckOk: boolean | null;
  lastHealthCheckError: string | null;
  environmentMismatch: boolean;
  /** The app's client id changed since this connection was made, so its tokens are dead. */
  appMismatch: boolean;
}

/** The organisation's Intuit app, as a screen may see it: ids yes, secrets never. */
export interface QuickBooksAppView {
  environment: "sandbox" | "production";
  sandbox: { clientId: string | null; hasClientSecret: boolean; redirectUri: string | null };
  production: { clientId: string | null; hasClientSecret: boolean; redirectUri: string | null };
  configuredAt: string | null;
  configuredByUserId: string | null;
  /** The live environment has all three fields, so a connect can be attempted. */
  ready: boolean;
}

export interface QuickBooksAppPayload {
  environment?: "sandbox" | "production";
  sandbox?: { clientId?: string; clientSecret?: string | null; redirectUri?: string };
  production?: { clientId?: string; clientSecret?: string | null; redirectUri?: string };
}

export function useQuickBooksApp() {
  return useQuery({
    queryKey: queryKeys.quickbooksApp,
    queryFn: () => fetchApi<{ app: QuickBooksAppView; suggestedRedirectUri: string }>("/api/integrations/quickbooks/credentials"),
  });
}

export function useSaveQuickBooksApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: QuickBooksAppPayload) =>
      fetchApi<{ app: QuickBooksAppView; suggestedRedirectUri: string }>("/api/integrations/quickbooks/credentials", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.quickbooksApp });
      // The connection card reads `configured` and `environment` off the app, so it is stale too.
      queryClient.invalidateQueries({ queryKey: queryKeys.quickbooksConnection });
    },
  });
}

export function useClearQuickBooksApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (environment?: "sandbox" | "production") =>
      fetchApi<{ app: QuickBooksAppView; suggestedRedirectUri: string }>(
        `/api/integrations/quickbooks/credentials${environment ? `?environment=${environment}` : ""}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.quickbooksApp });
      queryClient.invalidateQueries({ queryKey: queryKeys.quickbooksConnection });
    },
  });
}

export function useQuickBooksConnection() {
  return useQuery({
    queryKey: queryKeys.quickbooksConnection,
    queryFn: () =>
      fetchApi<{
        configured: boolean;
        environment: "sandbox" | "production" | null;
        redirectUri: string | null;
        connection: QuickBooksConnectionView;
      }>("/api/integrations/quickbooks"),
  });
}

/** Live read of the Classes and chart of accounts; only fetched when the panel is open. */
export function useQuickBooksChart(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.quickbooksChart,
    enabled,
    staleTime: 60_000,
    queryFn: () =>
      fetchApi<{
        classes: { id: string; name: string; fullyQualifiedName: string | null; active: boolean }[];
        accounts: {
          id: string;
          name: string;
          acctNum: string | null;
          accountType: string | null;
          accountSubType: string | null;
          classification: string | null;
          active: boolean;
          fullyQualifiedName: string | null;
        }[];
        counts: { classes: number; accounts: number };
      }>("/api/integrations/quickbooks/chart"),
  });
}

export function useTestQuickBooksConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchApi<{ ok: boolean; company: { companyName: string | null; legalName: string | null; homeCurrency: string | null; multiCurrencyEnabled: boolean | null } }>(
        "/api/integrations/quickbooks/test",
        { method: "POST" },
      ),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.quickbooksConnection });
    },
  });
}

export function useDisconnectQuickBooks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchApi<{ disconnected: boolean; revoked: boolean }>("/api/integrations/quickbooks", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.quickbooksConnection });
      queryClient.removeQueries({ queryKey: queryKeys.quickbooksChart });
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
        hasClientSecret: boolean;
        accountId: string | null;
        clientId: string | null;
        configuredAt: string | null;
        sdkKeyDev: string | null;
        hasSdkSecretDev: boolean;
        sdkKeyProd: string | null;
        hasSdkSecretProd: boolean;
        sdkMode: string;
      }>("/api/organization/zoom/credentials"),
  });
}

export function useSaveZoomCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      accountId: string;
      clientId: string;
      clientSecret?: string;
      sdkKeyDev?: string;
      sdkSecretDev?: string;
      sdkKeyProd?: string;
      sdkSecretProd?: string;
      sdkMode?: "dev" | "prod";
    }) =>
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

// ============ ORG STRIPE + AI CREDENTIALS (per-tenant keys, item 7) ============

export function useStripeCredentials() {
  return useQuery({
    queryKey: queryKeys.stripeCredentials,
    queryFn: () =>
      fetchApi<{
        configured: boolean;
        hasSecretKey: boolean;
        hasWebhookSecret: boolean;
        secretKeyLast4: string | null;
        keyMode: "live" | "test" | null;
        configuredAt: string | null;
        webhookUrl: string;
      }>("/api/organization/stripe/credentials"),
  });
}

export function useSaveStripeCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { secretKey?: string; webhookSecret?: string }) =>
      fetchApi("/api/organization/stripe/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stripeCredentials });
    },
  });
}

export function useDeleteStripeCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchApi("/api/organization/stripe/credentials", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stripeCredentials });
    },
  });
}

export function useTestStripeConnection() {
  return useMutation({
    mutationFn: () =>
      fetchApi<{
        success: boolean;
        source?: "org" | "env";
        error?: string;
        account?: { name: string | null; email: string | null; id: string };
      }>("/api/organization/stripe/test-connection", { method: "POST" }),
  });
}

// ============ ORG DET eTicketing CREDENTIALS (docs/DTCM_ETICKET_PLAN.md) ============

export function useDtcmEticketCredentials() {
  return useQuery({
    queryKey: queryKeys.dtcmEticketCredentials,
    queryFn: () => fetchApi<DetCredentialsStatus>("/api/organization/dtcm-eticket/credentials"),
  });
}

export function useSaveDtcmEticketCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { environment: DetEnvironment; clientId: string; clientSecret?: string; apiKey?: string; activate?: boolean }) =>
      fetchApi<DetCredentialsStatus>("/api/organization/dtcm-eticket/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dtcmEticketCredentials });
    },
  });
}

export function useDeleteDtcmEticketCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchApi("/api/organization/dtcm-eticket/credentials", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dtcmEticketCredentials });
    },
  });
}

export function useTestDtcmEticketConnection() {
  return useMutation({
    mutationFn: (data: { environment: DetEnvironment; performanceCode?: string }) =>
      fetchApi<{
        success: boolean;
        environment: DetEnvironment;
        clientId?: string;
        performance?: DetPerformanceSummary | null;
        error?: string;
      }>("/api/organization/dtcm-eticket/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
  });
}

export interface DtcmEventSectionsResponse {
  requiresDtcmBarcode: boolean;
  performanceCode: string | null;
  mapping: {
    sections: Record<string, DtcmSectionMapping>;
    environment: DetEnvironment | null;
    performanceCode: string | null;
    checkedAt: string | null;
  };
  ticketTypes: { id: string; name: string; isFaculty: boolean; isActive: boolean; registrations: number }[];
  det:
    | { performance: DetPerformanceSummary; environment: DetEnvironment; error: null }
    | { performance: null; environment: DetEnvironment | null; error: { message: string; stage: string; code: string } }
    | null;
}

/** Keyed by the performance code too, so a changed code never shows the old performance from cache. */
export function useDtcmEventSections(eventId: string, performanceCode: string) {
  return useQuery({
    queryKey: [...queryKeys.dtcmEventSections(eventId), performanceCode],
    queryFn: () => fetchApi<DtcmEventSectionsResponse>(`/api/events/${eventId}/dtcm-eticket`),
    // DET is a government API on the far side of a whitelist: no refetch on every focus.
    refetchOnWindowFocus: false,
  });
}

export function useSaveDtcmEventSections(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sections: Record<string, DtcmSectionMapping | null>) =>
      fetchApi(`/api/events/${eventId}/dtcm-eticket`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dtcmEventSections(eventId) });
    },
  });
}

export interface DtcmOrderSummary {
  id: string;
  status: "PENDING" | "PURCHASED" | "FAILED" | "UNCERTAIN" | "REVERSED";
  environment: DetEnvironment;
  orderId: string | null;
  barcode: string | null;
  area: string;
  priceTypeCode: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  /** UNCERTAIN, or a PENDING left by a crash: a person must resolve it. */
  unresolved: boolean;
}

export function useRegistrationDtcmOrders(eventId: string, registrationId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dtcmRegistrationOrders(eventId, registrationId),
    queryFn: () =>
      fetchApi<{ detReady: boolean; environment: DetEnvironment | null; orders: DtcmOrderSummary[] }>(
        `/api/events/${eventId}/registrations/${registrationId}/dtcm-eticket`,
      ),
    enabled,
    refetchOnWindowFocus: false,
  });
}

/** One DET purchase per registration is one mutation key, so other components can see it in flight. */
function dtcmIssueMutationKey(eventId: string, registrationId: string) {
  return ["dtcm-issue-from-det", eventId, registrationId] as const;
}

/**
 * Whether a "Get code from DET" press for this registration is still in
 * flight, from any component (the button lives inside `DtcmDetControls`). The
 * onsite desk holds its spare-code button on it: a spare taken while DET is
 * selling leaves a bought ticket nobody holds (review of 243b7136).
 */
export function useIsIssuingDtcmFromDet(eventId: string, registrationId: string): boolean {
  return useIsMutating({ mutationKey: dtcmIssueMutationKey(eventId, registrationId) }) > 0;
}

export function useIssueDtcmFromDet(eventId: string, registrationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: dtcmIssueMutationKey(eventId, registrationId),
    mutationFn: () =>
      fetchApi<{ source: "det" | "pool"; barcode: string; detError?: string }>(
        `/api/events/${eventId}/registrations/${registrationId}/dtcm-eticket`,
        { method: "POST" },
      ),
    // Success or not, the order list changed (a FAILED or UNCERTAIN row is news too).
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dtcmRegistrationOrders(eventId, registrationId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dtcmPool(eventId) });
    },
  });
}

export function useResolveDtcmOrder(eventId: string, registrationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { dtcmOrderId: string; body: { action: "found"; detOrderId: string } | { action: "not-bought" } | { action: "read-barcode" } }) =>
      fetchApi<{ order: { id: string; status: string; orderId: string | null }; barcode: string | null }>(
        `/api/events/${eventId}/dtcm-orders/${args.dtcmOrderId}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args.body) },
      ),
    onSettled: () => {
      // A resolve can put a code on the registration or settle an unused ticket.
      queryClient.invalidateQueries({ queryKey: queryKeys.dtcmRegistrationOrders(eventId, registrationId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dtcmUnusedOrders(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
    },
  });
}

export interface DtcmRunSummary {
  id: string;
  status: "RUNNING" | "STOPPED" | "COMPLETED" | "CANCELLED";
  environment: DetEnvironment;
  expected: number;
  soldOutAreas: string[];
  stopReason: string | null;
  startedAt: string;
  finishedAt: string | null;
  lastTickAt: string | null;
  progress: { purchased: number; failed: number; uncertain: number; inFlight: number };
}

export interface DtcmRunPreflight {
  environment: DetEnvironment;
  performanceCode: string;
  eligible: number;
  notNeeded: number;
  problems: { reason: string; count: number; message: string }[];
  sections: { area: string; name: string; needed: number; headroom: number | null; over: boolean }[];
  overCapacity: boolean;
  /** Who and which sections were shown; handed back on start. */
  fingerprint: string;
}

/** The latest run; polls while one is working. */
export function useDtcmRun(eventId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.dtcmRun(eventId),
    queryFn: () => fetchApi<{ run: DtcmRunSummary | null }>(`/api/events/${eventId}/dtcm-eticket/run`),
    enabled,
    refetchInterval: (query) => (query.state.data?.run?.status === "RUNNING" ? 10_000 : false),
  });
}

/** What a run would do now. Reads DET, so only on demand. */
export function useDtcmRunPreflight(eventId: string) {
  return useMutation({
    mutationFn: () =>
      fetchApi<{ preflight: DtcmRunPreflight | null; preflightError?: { code: string; message: string } }>(
        `/api/events/${eventId}/dtcm-eticket/run?preflight=1`,
      ),
  });
}

export function useStartDtcmRun(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (confirm: { environment: DetEnvironment; performanceCode: string; count: number; fingerprint: string }) =>
      fetchApi(`/api/events/${eventId}/dtcm-eticket/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm }),
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.dtcmRun(eventId) }),
  });
}

export function useCancelDtcmRun(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchApi(`/api/events/${eventId}/dtcm-eticket/run`, { method: "DELETE" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.dtcmRun(eventId) }),
  });
}

export interface DtcmUnusedOrder {
  id: string;
  environment: DetEnvironment;
  orderId: string | null;
  area: string;
  registrationId: string | null;
  name: string | null;
  reason: "REGISTRATION_DELETED" | "REGISTRATION_CANCELLED" | "BARCODE_NOT_ON_REGISTRATION";
}

export function useDtcmUnusedOrders(eventId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.dtcmUnusedOrders(eventId),
    queryFn: () => fetchApi<{ unused: DtcmUnusedOrder[] }>(`/api/events/${eventId}/dtcm-orders`),
    enabled,
  });
}

export function useReverseDtcmOrder(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { dtcmOrderId: string; action: "reverse" | "mark-reversed" }) =>
      fetchApi<{ clearedRegistrationCode: boolean; codeStillInUse: boolean }>(`/api/events/${eventId}/dtcm-orders/${args.dtcmOrderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: args.action }),
      }),
    onSettled: () => {
      // The unused list, every registration's DET panel, the run card. NOT the
      // DET sections map: refetching it calls DET and can drop an unsaved
      // mapping on the settings page.
      queryClient.invalidateQueries({ queryKey: queryKeys.dtcmUnusedOrders(eventId) });
      queryClient.invalidateQueries({ queryKey: ["dtcm-eticket", "registration", eventId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.dtcmRun(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
    },
  });
}

export interface AiProviderCredentialState {
  configured: boolean;
  apiKeyLast4: string | null;
  configuredAt: string | null;
  envFallbackAvailable: boolean;
}

export function useAiCredentials() {
  return useQuery({
    queryKey: queryKeys.aiCredentials,
    queryFn: () =>
      fetchApi<{
        helpChatProvider: "anthropic" | "openai";
        anthropic: AiProviderCredentialState;
        openai: AiProviderCredentialState;
      }>("/api/organization/ai/credentials"),
  });
}

export function useSaveAiCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      helpChatProvider?: "anthropic" | "openai";
      anthropicApiKey?: string;
      openaiApiKey?: string;
    }) =>
      fetchApi("/api/organization/ai/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aiCredentials });
    },
  });
}

export function useDeleteAiCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { provider: "anthropic" | "openai" }) =>
      fetchApi("/api/organization/ai/credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aiCredentials });
    },
  });
}

export function useTestAiConnection() {
  return useMutation({
    mutationFn: (data: { provider: "anthropic" | "openai" }) =>
      fetchApi<{ success: boolean; source?: "org" | "env"; provider?: string; error?: string }>(
        "/api/organization/ai/test-connection",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      ),
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
        orgConfigured: boolean;
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
      liveStreamEnabled?: boolean;
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

// ── Webinar Console ─────────────────────────────────────────────────

export interface WebinarConsoleData {
  event: { id: string; name: string; slug: string; eventType: string | null; status?: string; timezone?: string | null };
  webinar: {
    autoCreated?: boolean;
    sessionId?: string;
    autoProvisionZoom?: boolean;
    defaultPasscode?: string;
    waitingRoom?: boolean;
    autoRecording?: "none" | "local" | "cloud";
    automationEnabled?: boolean;
    viewingMode?: "zoom" | "hls";
    lobbyVideoUrl?: string;
    lobbyImageUrl?: string;
    lobbyMessage?: string;
    pageLogoUrl?: string;
    pageBackgroundUrl?: string;
    pageFooterImageUrl?: string;
    endSurveyId?: string;
    thankYouSurveyLink?: boolean;
    qaUpvote?: boolean;
    livePolls?: boolean;
    showRecording?: boolean;
    /** The organiser's uploaded replay, a Vimeo video link (webinar/replay.ts). */
    replayUrl?: string;
    handouts?: WebinarHandout[];
    exitUrl?: string;
  };
  /** The organisation's website: the thank-you screen's exit button when the webinar sets none. */
  orgWebsite?: string | null;
  anchorSession: {
    id: string;
    name: string;
    startTime: string;
    endTime: string;
    description: string | null;
    status: "DRAFT" | "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  } | null;
  zoomMeeting: {
    id: string;
    zoomMeetingId: string;
    meetingType: string;
    joinUrl: string;
    startUrl: string | null;
    passcode: string | null;
    duration: number | null;
    recordingUrl: string | null;
    recordingPassword: string | null;
    recordingDuration: number | null;
    recordingFetchedAt: string | null;
    recordingStatus: "NOT_REQUESTED" | "PENDING" | "AVAILABLE" | "FAILED" | "EXPIRED";
  } | null;
}

export function useWebinar(eventId: string) {
  return useQuery({
    queryKey: queryKeys.webinar(eventId),
    queryFn: () => fetchApi<WebinarConsoleData>(`/api/events/${eventId}/webinar`),
    enabled: !!eventId,
  });
}

export function useUpdateWebinarSettings(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<WebinarConsoleData["webinar"]>) =>
      fetchApi<{ webinar: WebinarConsoleData["webinar"] }>(
        `/api/events/${eventId}/webinar`,
        { method: "PUT", body: JSON.stringify(data), headers: { "Content-Type": "application/json" } },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinar(eventId) });
    },
  });
}

/** Webinar handouts (Oct 6, 2026): each change returns the new list and refreshes the console. */
export function useUploadWebinarHandout(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return fetchApi<{ handouts: WebinarHandout[] }>(`/api/events/${eventId}/webinar/handouts`, { method: "POST", body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinar(eventId) });
    },
  });
}

export function useReorderWebinarHandouts(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (order: string[]) =>
      fetchApi<{ handouts: WebinarHandout[] }>(`/api/events/${eventId}/webinar/handouts`, {
        method: "PATCH",
        body: JSON.stringify({ order }),
        headers: { "Content-Type": "application/json" },
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinar(eventId) });
    },
  });
}

export function useDeleteWebinarHandout(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (handoutId: string) =>
      fetchApi<{ handouts: WebinarHandout[] }>(`/api/events/${eventId}/webinar/handouts/${encodeURIComponent(handoutId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinar(eventId) });
    },
  });
}

export function useProvisionWebinar(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchApi<{
        ok: boolean;
        sessionId?: string;
        zoomMeetingId?: string | null;
        zoomStatus?: "created" | "already-attached" | "not-configured" | "failed";
        durationMs?: number;
        reason?: string;
      }>(
        `/api/events/${eventId}/webinar`,
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinar(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.webinarSequence(eventId) });
    },
  });
}

/** Producer "Open the room / Go live" — sets the anchor session LIVE (open) or COMPLETED (close). */
export function useToggleWebinarRoom(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (open: boolean) =>
      fetchApi<{
        open: boolean;
        sessionId: string;
        status: string;
        stream?: { ok: true; alreadyLive?: true } | { ok: false; error: string };
      }>(
        `/api/events/${eventId}/webinar/room`,
        { method: "POST", body: JSON.stringify({ open }), headers: { "Content-Type": "application/json" } },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinar(eventId) });
    },
  });
}

/**
 * The HLS address for the console's stream preview. Fetched only while the
 * preview is open; null until the anchor session has a stream set up.
 */
export function useWebinarStreamPreview(eventId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.webinar(eventId), "stream-preview"] as const,
    queryFn: () =>
      fetchApi<{ rtmpIngestUrl: string; hlsPreviewUrl: string | null }>(
        `/api/events/${eventId}/webinar/livestream`,
      ),
    enabled,
  });
}

/** One of an event's surveys, as the survey list returns it. */
export interface EventSurveyListItem {
  id: string;
  name: string;
  config: unknown;
  isActive: boolean;
  gatesCertificates: boolean;
  responseCount: number;
  /** Phase 4: "ONCE" or "ONCE_PER_DAY". */
  responseMode?: "ONCE" | "ONCE_PER_DAY";
}

/** An event's surveys (several per event since Oct 6, 2026): the CME survey
 *  and any extra ones. Used by the Survey Invitation pickers. */
export function useEventSurveys(eventId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.surveys(eventId),
    queryFn: () =>
      fetchApi<{ surveys: EventSurveyListItem[] }>(`/api/events/${eventId}/surveys`).then((d) => d.surveys),
    enabled: enabled && !!eventId,
  });
}

/** Custom stream controls: send settings to Zoom, start or stop the push. */
export function useWebinarLiveStream(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: "sync" | "start" | "stop") =>
      fetchApi<{ ok: true; action: string; notRunning?: boolean }>(`/api/events/${eventId}/webinar/livestream`, {
        method: "POST",
        body: JSON.stringify({ action }),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinar(eventId) });
    },
  });
}

export interface WebinarViewerQuestionRow {
  id: string;
  askerName: string;
  question: string;
  status: "NEW" | "ANSWERED" | "DISMISSED";
  /** Shown to every attendee in the Q&A panel beside the video. */
  isPublic: boolean;
  createdAt: string;
  answeredAt: string | null;
  /** Attendee upvotes (Oct 6, 2026). */
  voteCount: number;
}

/** Questions from custom-stream viewers; polled every 10 s while shown. */
export function useWebinarViewerQuestions(eventId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["webinar-viewer-questions", eventId],
    queryFn: () =>
      fetchApi<{ questions: WebinarViewerQuestionRow[] }>(`/api/events/${eventId}/webinar/questions`),
    enabled: !!eventId && enabled,
    refetchInterval: 10_000,
  });
}

/** One chat message in the console: the real author always (Nov 6, 2026). */
export interface WebinarChatConsoleMessage {
  id: string;
  body: string;
  authorName: string;
  authorKind: "attendee" | "staff";
  anonymous: boolean;
  kind: "message" | "handout";
  handoutName: string | null;
  registrationId: string | null;
  authorMuted: boolean;
  deleted: boolean;
  pinned: boolean;
  createdAt: string;
}

export interface WebinarChatConsole {
  chat: import("@/lib/webinar/chat").WebinarChatSettings;
  moderator: { id: string; name: string; isMe: boolean } | null;
  messages: WebinarChatConsoleMessage[];
  muted: { registrationId: string; name: string }[];
  handouts: { id: string; name: string }[];
}

/** The webinar's chat for moderation; refreshed every 3 s while the Chat tab is open. */
export function useWebinarChatConsole(eventId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["webinar-chat-console", eventId],
    queryFn: () => fetchApi<WebinarChatConsole>(`/api/events/${eventId}/webinar/chat`),
    enabled: !!eventId && enabled,
    refetchInterval: 3_000,
  });
}

export function useUpdateWebinarChatSettings(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { enabled?: boolean; openInLobby?: boolean; mutedAll?: boolean; slowMode?: boolean; moderator?: "me" }) =>
      fetchApi<{ chat: unknown }>(`/api/events/${eventId}/webinar/chat`, {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["webinar-chat-console", eventId] }),
  });
}

export type WebinarChatAction =
  | { action: "delete" | "restore" | "pin"; messageId: string }
  | { action: "unpin" }
  | { action: "mute" | "unmute"; registrationId: string }
  | { action: "post"; body: string; handoutId?: string };

export function useWebinarChatAction(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: WebinarChatAction) =>
      fetchApi<{ ok: true }>(`/api/events/${eventId}/webinar/chat`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["webinar-chat-console", eventId] }),
  });
}

/** A live poll in the console, with its tally (Oct 6, 2026). */
export interface LivePollRow {
  id: string;
  question: string;
  options: LivePollOption[];
  allowMultiple: boolean;
  status: "DRAFT" | "OPEN" | "CLOSED";
  showResults: boolean;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  tally: PollTally;
}

/** The webinar's live polls; refreshed every 5 s while the Polls tab is open. */
export function useLivePolls(eventId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["webinar-live-polls", eventId],
    queryFn: () => fetchApi<{ polls: LivePollRow[] }>(`/api/events/${eventId}/webinar/polls`).then((d) => d.polls),
    enabled: !!eventId && enabled,
    refetchInterval: 5_000,
  });
}

export function useCreateLivePoll(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: { question: string; options: string[]; allowMultiple: boolean }) =>
      fetchApi<{ id: string }>(`/api/events/${eventId}/webinar/polls`, {
        method: "POST",
        body: JSON.stringify(draft),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["webinar-live-polls", eventId] }),
  });
}

export function useUpdateLivePoll(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pollId, ...body }: { pollId: string } & ({ action: "launch" | "close" } | { showResults: boolean })) =>
      fetchApi<{ ok: true }>(`/api/events/${eventId}/webinar/polls/${encodeURIComponent(pollId)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["webinar-live-polls", eventId] }),
  });
}

export function useDeleteLivePoll(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pollId: string) =>
      fetchApi<{ ok: true }>(`/api/events/${eventId}/webinar/polls/${encodeURIComponent(pollId)}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["webinar-live-polls", eventId] }),
  });
}

export function useUpdateWebinarViewerQuestion(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status?: "NEW" | "ANSWERED" | "DISMISSED"; isPublic?: boolean }) =>
      fetchApi<{ ok: true }>(`/api/events/${eventId}/webinar/questions`, {
        method: "PATCH",
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["webinar-viewer-questions", eventId] });
    },
  });
}

export interface WebinarSequenceRow {
  id: string;
  emailType: string;
  status: "PENDING" | "PROCESSING" | "SENT" | "FAILED" | "CANCELLED";
  scheduledFor: string;
  sentAt: string | null;
  totalCount: number | null;
  successCount: number | null;
  failureCount: number | null;
  lastError: string | null;
  retryCount: number;
}

export function useWebinarSequence(eventId: string) {
  return useQuery({
    queryKey: queryKeys.webinarSequence(eventId),
    queryFn: () => fetchApi<{ rows: WebinarSequenceRow[] }>(`/api/events/${eventId}/webinar/sequence`),
    enabled: !!eventId,
  });
}

export function useReenqueueWebinarSequence(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchApi<{
        ok: boolean;
        deleted: number;
        created: number;
        skipped: string | null;
      }>(`/api/events/${eventId}/webinar/sequence`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinarSequence(eventId) });
    },
  });
}

export function useFetchWebinarRecording(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchApi<{
        ok: boolean;
        status: "available" | "pending" | "expired" | "failed";
        recordingUrl?: string;
        reason?: string;
        durationMs?: number;
      }>(`/api/events/${eventId}/webinar/recording/fetch`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinar(eventId) });
    },
  });
}

export interface WebinarAttendeeRow {
  id: string;
  name: string;
  email: string | null;
  joinTime: string;
  leaveTime: string | null;
  durationSeconds: number;
  attentivenessScore: number | null;
  registrationId: string | null;
  registrationSerialId: number | null;
}

export interface WebinarAttendanceData {
  kpis: {
    registered: number;
    attended: number;
    attendanceRate: number;
    avgWatchSeconds: number;
    totalWatchSeconds: number;
    peakConcurrent: number;
    lastSyncedAt: string | null;
  };
  rows: WebinarAttendeeRow[];
}

export function useWebinarAttendance(eventId: string) {
  return useQuery({
    queryKey: queryKeys.webinarAttendance(eventId),
    queryFn: () => fetchApi<WebinarAttendanceData>(`/api/events/${eventId}/webinar/attendance`),
    enabled: !!eventId,
  });
}

export interface WebinarPresenceRow {
  id: string;
  phase: "lobby" | "joined" | string;
  name: string;
  email: string | null;
  serialId: number | null;
  firstJoinedAt: string;
  lastSeenAt: string;
  joinCount: number;
}

export interface WebinarPresenceData {
  lobby: number;
  joined: number;
  total: number;
  rows: WebinarPresenceRow[];
}

/** Real-time lobby/live presence — polls every ~18s while the console is open. */
export function useWebinarPresence(eventId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.webinarPresence(eventId),
    queryFn: () => fetchApi<WebinarPresenceData>(`/api/events/${eventId}/webinar/presence`),
    enabled: !!eventId && enabled,
    refetchInterval: 18000,
  });
}

export interface WebinarStreamTimelineEntry {
  id: string;
  kind:
    | "ROOM_OPENED"
    | "ROOM_CLOSED"
    | "ROOM_AUTO_CLOSED"
    | "STREAM_START_PRESSED"
    | "STREAM_STOP_PRESSED"
    | "STREAM_LIVE"
    | "STREAM_DROPPED"
    | "AUTO_RESTART_REQUESTED"
    | "AUTO_RESTART_FAILED";
  at: string;
  user: { firstName: string; lastName: string } | null;
  detail: string | null;
}

/** The console's Stream timeline; refreshed every 15 s while the room is open (Nov 5, 2026). */
export function useWebinarStreamTimeline(eventId: string, live: boolean) {
  return useQuery({
    queryKey: queryKeys.webinarStreamTimeline(eventId),
    queryFn: () => fetchApi<{ entries: WebinarStreamTimelineEntry[] }>(`/api/events/${eventId}/webinar/stream-timeline`),
    enabled: !!eventId,
    refetchInterval: live ? 15_000 : false,
  });
}

export function useSyncWebinarAttendance(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchApi<{
        ok: boolean;
        status: "synced" | "pending" | "failed";
        fetched?: number;
        upserted?: number;
        matched?: number;
        reason?: string;
        durationMs?: number;
      }>(`/api/events/${eventId}/webinar/attendance`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinarAttendance(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.webinar(eventId) });
    },
  });
}

// ── Webinar engagement (polls + Q&A) ────────────────────────────────

export interface WebinarPollResponseRow {
  id: string;
  participantName: string;
  participantEmail: string | null;
  answers: Record<string, string>;
  submittedAt: string;
}

export interface WebinarPollRow {
  id: string;
  title: string;
  questions: string[];
  createdAt: string;
  responses: WebinarPollResponseRow[];
}

export interface WebinarQaRow {
  id: string;
  askerName: string;
  askerEmail: string | null;
  question: string;
  answer: string | null;
  answeredByName: string | null;
  askedAt: string;
}

export interface WebinarEngagementData {
  polls: WebinarPollRow[];
  questions: WebinarQaRow[];
  lastSyncedAt: string | null;
}

export function useWebinarEngagement(eventId: string) {
  return useQuery({
    queryKey: queryKeys.webinarEngagement(eventId),
    queryFn: () =>
      fetchApi<WebinarEngagementData>(`/api/events/${eventId}/webinar/engagement`),
    enabled: !!eventId,
  });
}

export function useSyncWebinarEngagement(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchApi<{
        ok: boolean;
        status: "synced" | "pending" | "failed";
        pollsPersisted?: number;
        pollResponsesPersisted?: number;
        questionsPersisted?: number;
        pollsReportNotReady?: boolean;
        qaReportNotReady?: boolean;
        reason?: string;
        durationMs?: number;
      }>(`/api/events/${eventId}/webinar/engagement`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinarEngagement(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.webinar(eventId) });
    },
  });
}

// ── Webinar panelists ──────────────────────────────────────────────

export interface WebinarPanelist {
  id: string;
  name: string;
  email: string;
  join_url?: string;
}

export function useWebinarPanelists(eventId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.webinarPanelists(eventId),
    queryFn: () =>
      fetchApi<{ panelists: WebinarPanelist[] }>(
        `/api/events/${eventId}/webinar/panelists`,
      ),
    enabled: !!eventId && enabled,
  });
}

// Local sentinel ID prefix so the UI can detect and grey out rows we inserted
// optimistically (they have no real Zoom panelist id yet).
export const OPTIMISTIC_PANELIST_PREFIX = "optimistic:";

export function useAddWebinarPanelist(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; email: string }) =>
      fetchApi<{ ok: boolean; invitesQueued?: number }>(
        `/api/events/${eventId}/webinar/panelists`,
        {
          method: "POST",
          body: JSON.stringify(data),
          headers: { "Content-Type": "application/json" },
        },
      ),
    // Optimistically append the new panelist so the table updates instantly,
    // then reconcile after the GET refetch returns the real Zoom row.
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.webinarPanelists(eventId) });
      const previous = queryClient.getQueryData<{ panelists: WebinarPanelist[] }>(
        queryKeys.webinarPanelists(eventId),
      );
      const optimisticRow: WebinarPanelist = {
        id: `${OPTIMISTIC_PANELIST_PREFIX}${Date.now()}`,
        name: data.name,
        email: data.email,
      };
      queryClient.setQueryData<{ panelists: WebinarPanelist[] }>(
        queryKeys.webinarPanelists(eventId),
        (old) => ({ panelists: [...(old?.panelists ?? []), optimisticRow] }),
      );
      return { previous };
    },
    onError: (_err, _data, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.webinarPanelists(eventId), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinarPanelists(eventId) });
    },
  });
}

export function useRemoveWebinarPanelist(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (panelistId: string) =>
      fetchApi<{ ok: boolean }>(
        `/api/events/${eventId}/webinar/panelists?panelistId=${encodeURIComponent(panelistId)}`,
        { method: "DELETE" },
      ),
    // Optimistically drop the row so the table updates instantly. Rolled back
    // on error (e.g. Zoom API failure) before the refetch reconciles.
    onMutate: async (panelistId) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.webinarPanelists(eventId) });
      const previous = queryClient.getQueryData<{ panelists: WebinarPanelist[] }>(
        queryKeys.webinarPanelists(eventId),
      );
      queryClient.setQueryData<{ panelists: WebinarPanelist[] }>(
        queryKeys.webinarPanelists(eventId),
        (old) => ({
          panelists: (old?.panelists ?? []).filter((p) => p.id !== panelistId),
        }),
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.webinarPanelists(eventId), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinarPanelists(eventId) });
    },
  });
}

export function useSyncSpeakersToPanelists(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchApi<{
        ok: boolean;
        added: number;
        totalSpeakers: number;
        skippedNoEmail: number;
        skippedAlreadyPanelist?: number;
        invitesQueued?: number;
        reason?: string;
      }>(`/api/events/${eventId}/webinar/panelists/sync-speakers`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webinarPanelists(eventId) });
    },
  });
}

// Resend the panelist invitation email. Does not mutate the panelist list —
// no cache invalidation needed. Callers should surface success/failure via
// sonner toasts.
export function useResendPanelistInvite(eventId: string) {
  return useMutation({
    mutationFn: (panelistId: string) =>
      fetchApi<{ ok: boolean }>(
        `/api/events/${eventId}/webinar/panelists/${encodeURIComponent(panelistId)}/resend`,
        { method: "POST" },
      ),
  });
}

// ── Sponsors (event.settings.sponsors JSON) ────────────────────────
// Re-export the canonical type from src/lib/webinar.ts so there's one
// source of truth. Consumers that import SponsorEntry from this hooks
// file don't need to change.
import type { SponsorEntry, SponsorTier } from "@/lib/webinar";
import type { SponsorTierDef } from "@/lib/sponsor-tiers";
import type { VenueRoom } from "@/lib/venue/rooms";
import type { VenuePlan } from "@/lib/venue/plan";
import type { StandSponsorRef } from "@/lib/venue/stands";
export type { SponsorEntry, SponsorTier, SponsorTierDef };

export function useSponsors(eventId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.sponsors(eventId),
    queryFn: () =>
      fetchApi<{ sponsors: SponsorEntry[]; tiers: SponsorTierDef[] }>(
        `/api/events/${eventId}/sponsors`,
      ),
    enabled: !!eventId && enabled,
  });
}

export function useUpdateSponsors(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sponsors: SponsorEntry[]) =>
      fetchApi<{ sponsors: SponsorEntry[] }>(
        `/api/events/${eventId}/sponsors`,
        {
          method: "PUT",
          body: JSON.stringify({ sponsors }),
          headers: { "Content-Type": "application/json" },
        },
      ),
    onSuccess: (data) => {
      // Write the server response back into the cache — it carries the
      // normalized sortOrder indices + trimmed strings, so the UI
      // reflects exactly what was persisted without a second roundtrip.
      // Merged, so the tier list the GET carried survives the save.
      queryClient.setQueryData(queryKeys.sponsors(eventId), (old: { tiers?: SponsorTierDef[] } | undefined) => ({ ...old, ...data }));
    },
  });
}

/** The organisation's custom sponsor tiers, saved as a whole (built-ins are fixed). */
export function useUpdateSponsorTiers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tiers: { key?: string; label: string }[]) =>
      fetchApi<{ tiers: SponsorTierDef[] }>("/api/organization/sponsor-tiers", {
        method: "PUT",
        body: JSON.stringify({ tiers }),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: () => {
      // Every event's sponsors query carries the list, so refresh them all.
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "events" && q.queryKey[2] === "sponsors" });
      queryClient.invalidateQueries({ queryKey: queryKeys.sponsorTiers });
    },
  });
}

// ============ ONLINE VENUE ROOMS (docs/EVENT_BLUEPRINT_PLAN.md, D9) ============
// The event's Venue tab: the room list the walkable venue is built from.
// `version` is the save the editor loaded; a save from an older one gets 409.

export interface VenueRoomsData {
  rooms: VenueRoom[] | null;
  version: number;
  /** The generated venue is open to staff (only with saved rooms). */
  open?: boolean;
  slug?: string;
  /** The event's sessions and sponsor count, to show which room each lands in; null when they could not be read. */
  programme?: { sessions: { title: string; location: string | null; track: string | null }[]; sponsors: number; standSponsors: StandSponsorRef[] } | null;
  /** The event's approved Blueprint, its spaces as rooms and what was changed to fit; null without one or without blueprints.view. */
  blueprint?: { id: string; title: string; ref: string | null; spaces: number; rooms: VenueRoom[]; notes: string[] } | null;
  /**
   * The drawn floor plan (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md), null while the
   * venue is automatic. `mode` says which the venue uses; `issues` say why a
   * saved plan no longer fits the rooms (the venue is then automatic).
   */
  plan?: { plan: VenuePlan; version: number; mode: "automatic" | "drawn"; issues: string[] } | null;
  /** Where the venue's safety reports are emailed (the organisation's company email); null when it has none. */
  safetyInbox?: string | null;
}

export function useVenueRooms(eventId: string) {
  return useQuery({
    queryKey: queryKeys.venueRooms(eventId),
    queryFn: () => fetchApi<VenueRoomsData>(`/api/events/${eventId}/venue`),
    enabled: !!eventId,
  });
}

export function useSaveVenueRooms(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { rooms: VenueRoom[]; version: number }) =>
      fetchApi<VenueRoomsData>(`/api/events/${eventId}/venue`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: (data) => queryClient.setQueryData<VenueRoomsData>(queryKeys.venueRooms(eventId), (cur) => ({ ...cur, ...data })),
  });
}

/** Store the venue's own drawing (an image; the editor turns a PDF into one first). The plan says where it goes when saved. */
export function useUploadVenueDrawing(eventId: string) {
  return useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return fetchApi<{ path: string }>(`/api/events/${eventId}/venue/drawing`, { method: "POST", body });
    },
  });
}

/** Where the editor and the plan view load a stored drawing from (the private file, through the event). */
export const venueDrawingUrl = (eventId: string, path: string) => `/api/events/${eventId}/venue/drawing?path=${encodeURIComponent(path)}`;

/** Save the drawn floor plan, or with `plan: null` go back to the automatic one. A refusal is an ApiError whose `data.issues` lists every reason. */
export function useSaveVenuePlan(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { plan: VenuePlan | null; planVersion: number }) =>
      fetchApi<{ plan: VenuePlan | null; planVersion: number }>(`/api/events/${eventId}/venue`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    // The GET says which plan the venue now uses (and why not), so it is read again.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.venueRooms(eventId) }),
  });
}

export function useSetVenueOpen(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (open: boolean) =>
      fetchApi<{ open: boolean }>(`/api/events/${eventId}/venue`, {
        method: "PUT",
        body: JSON.stringify({ open }),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: ({ open }) => queryClient.setQueryData<VenueRoomsData>(queryKeys.venueRooms(eventId), (cur) => (cur ? { ...cur, open } : cur)),
  });
}

/** The exhibitor floor plan link (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10): one per event, or none yet. */
export interface VenueShareLinkData {
  link: { path: string; enabled: boolean; updatedAt: string; updatedBy: string | null } | null;
}

export function useVenueShareLink(eventId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.venueShareLink(eventId),
    queryFn: () => fetchApi<VenueShareLinkData>(`/api/events/${eventId}/venue/share-link`),
    enabled: !!eventId && enabled,
  });
}

export function useChangeVenueShareLink(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: "create" | "replace" | "enable" | "disable") =>
      fetchApi<VenueShareLinkData>(`/api/events/${eventId}/venue/share-link`, {
        method: "POST",
        body: JSON.stringify({ action }),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.venueShareLink(eventId), data),
  });
}

// ============ ISSUED CERTIFICATES (per-recipient) ============
// Backs the IssuedCertificatesCard on registration / speaker detail
// surfaces. Lists the certs already issued for one recipient + lets
// the operator resend any individual one.

export interface IssuedCertificateRow {
  id: string;
  type: "ATTENDANCE" | "APPRECIATION";
  serial: string;
  pdfUrl: string | null;
  issuedAt: string;
  lastResentAt: string | null;
  resendCount: number;
  lastReissuedAt: string | null;
  reissueCount: number;
  revokedAt: string | null;
  revocationReason: string | null;
  certificateTemplate: { id: string; name: string } | null;
  issueRunItem: {
    emailedAt: string | null;
    errorPhase: string | null;
    errorMessage: string | null;
  } | null;
}

interface UseIssuedCertificatesArgs {
  eventId: string;
  registrationId?: string;
  speakerId?: string;
  /** False when the caller may not read certificates (useCan). */
  enabled?: boolean;
}

export function useIssuedCertificates({
  eventId,
  registrationId,
  speakerId,
  enabled: allowed = true,
}: UseIssuedCertificatesArgs) {
  const enabled = allowed && !!eventId && (!!registrationId || !!speakerId);
  // Build the URL query string for whichever id is set. The route
  // rejects requests that supply both, which would only happen on a
  // caller bug — we guard by passing exactly one.
  const qs = registrationId
    ? `registrationId=${encodeURIComponent(registrationId)}`
    : `speakerId=${encodeURIComponent(speakerId ?? "")}`;
  return useQuery({
    queryKey: queryKeys.issuedCertificates(eventId, { registrationId, speakerId }),
    queryFn: () =>
      fetchApi<{  certificates: IssuedCertificateRow[] }>(
        `/api/events/${eventId}/certificates/issued?${qs}`,
      ),
    enabled,
  });
}

/**
 * Read-only preview of what a resend would email — pass certificateId for a
 * per-row reissue preview, or registrationId/speakerId for the "Resend all"
 * bundle preview. No side effects.
 */
export function usePreviewResendEmail(eventId: string) {
  return useMutation({
    mutationFn: (body: { certificateId?: string; registrationId?: string; speakerId?: string }) =>
      fetchApi<{ subject: string; htmlContent: string; recipientEmail: string; serials: string[] }>(
        `/api/events/${eventId}/certificates/issued/resend-preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
  });
}

export function useResendCertificateBundle(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { registrationId?: string; speakerId?: string }) =>
      fetchApi<{ sentCount: number; serials: string[]; recipientEmail: string }>(
        `/api/events/${eventId}/certificates/issued/resend-bundle`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["events", eventId, "certificates", "issued"],
      });
      queryClient.invalidateQueries({ queryKey: ["email-logs"] });
    },
  });
}

export function useReissueCertificate(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (certificateId: string) =>
      fetchApi<{
        ok: true;
        certificateId: string;
        serial: string;
        recipientEmail: string;
        emailMessageId?: string;
      }>(
        `/api/events/${eventId}/certificates/issued/${certificateId}/reissue`,
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["events", eventId, "certificates", "issued"],
      });
      queryClient.invalidateQueries({ queryKey: ["email-logs"] });
    },
  });
}

export interface CertTemplateOption {
  id: string;
  name: string;
  category: "ATTENDANCE" | "APPRECIATION";
  /** Sent automatically once an assigned person answers the certificate survey. */
  autoIssueOnSurvey?: boolean;
  /** `assignments` = the people assigned the template: who receives it on
   *  every issue path (manual, bulk email, survey auto-issue). 0 = nobody. */
  _count?: { assignments?: number; issuedCertificates?: number; issueRuns?: number };
}

/** How many people a template is assigned to (0 while the list has not loaded). */
export function assignedCountOf(template: Pick<CertTemplateOption, "_count">): number {
  return template._count?.assignments ?? 0;
}

// ── Certificate assignments: who receives which certificate ──────────────────

export interface AssignCertificateBody {
  templateId: string;
  registrationIds?: string[];
  speakerIds?: string[];
  /** A pasted list, matched to the event's registrations (or speakers). */
  emails?: string[];
  /** Set once the person has agreed to the number of certificates sent at once. */
  confirmSendNow?: boolean;
  /** Work it out and write nothing. */
  dryRun?: boolean;
}

export interface AssignCertificateResponse {
  ok: true;
  templateName: string;
  assigned: number;
  alreadyAssigned: number;
  skipped: number;
  /** Certificates the survey auto-issue sends straight away. */
  sendNow: number;
  dryRun: boolean;
  /** From a pasted list: addresses nobody at the event has. */
  unmatched: string[];
  /** From a pasted list: addresses whose only registration is cancelled. */
  cancelled: string[];
}

/** Every query a change of assignments can make stale. */
function invalidateCertificateAssignments(queryClient: ReturnType<typeof useQueryClient>, eventId: string) {
  queryClient.invalidateQueries({ queryKey: ["events", eventId, "certificates"] });
  queryClient.invalidateQueries({ queryKey: ["cert-templates", eventId] });
  queryClient.invalidateQueries({ queryKey: ["cert-eligibility", eventId] });
  queryClient.invalidateQueries({ queryKey: ["cert-auto-issue-analytics", eventId] });
}

/**
 * Assign a certificate template to people. The server refuses with 409
 * CONFIRM_SEND_NOW (an ApiError whose `data.sendNow` is the count) when some
 * of them have already answered the survey and the template sends
 * automatically; send the same body again with `confirmSendNow: true`.
 */
export function useAssignCertificate(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AssignCertificateBody) =>
      fetchApi<AssignCertificateResponse>(`/api/events/${eventId}/certificates/assignments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: (res) => {
      if (!res.dryRun) invalidateCertificateAssignments(queryClient, eventId);
    },
  });
}

/** Take people off a template's list. Someone who holds the certificate stays (`keptIssued`). */
export function useUnassignCertificate(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { templateId: string; registrationIds?: string[]; speakerIds?: string[] }) =>
      fetchApi<{ ok: true; templateName: string; removed: number; keptIssued: number }>(
        `/api/events/${eventId}/certificates/assignments`,
        { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      ),
    onSuccess: () => invalidateCertificateAssignments(queryClient, eventId),
  });
}

/** The template ids assigned to ONE registration or speaker (their own card). */
export function usePersonCertificateAssignments(
  eventId: string,
  person: { registrationId?: string; speakerId?: string },
  enabled = true,
) {
  const param = person.registrationId ? `registrationId=${person.registrationId}` : `speakerId=${person.speakerId}`;
  return useQuery({
    queryKey: ["events", eventId, "certificates", "assignments", person.registrationId ?? null, person.speakerId ?? null],
    queryFn: () => fetchApi<{ templateIds: string[] }>(`/api/events/${eventId}/certificates/assignments?${param}`),
    enabled: enabled && Boolean(person.registrationId || person.speakerId),
  });
}

export type CertificateRecipientState =
  | "SENT"
  | "ISSUED_NOT_SENT"
  | "SENDING"
  | "WAITING_FOR_SURVEY"
  | "READY"
  | "FAILED"
  | "REVOKED"
  | "CANCELLED";

export interface CertificateRecipientRow {
  assignmentId: string;
  templateId: string;
  templateName: string;
  category: "ATTENDANCE" | "APPRECIATION";
  kind: "registration" | "speaker";
  registrationId: string | null;
  speakerId: string | null;
  name: string;
  email: string | null;
  registrationType: string | null;
  source: string;
  assignedAt: string;
  assignedByName: string | null;
  surveyAnsweredAt: string | null;
  state: CertificateRecipientState;
  cmeHours: string | null;
  certificate: { id: string; serial: string; issuedAt: string } | null;
}

export interface CertificateRecipientsReport {
  timezone: string;
  templates: Array<{
    id: string;
    name: string;
    category: "ATTENDANCE" | "APPRECIATION";
    autoIssueOnSurvey: boolean;
    assigned: number;
    counts: Record<CertificateRecipientState, number>;
  }>;
  rows: CertificateRecipientRow[];
  answeredNotAssigned: Array<{
    registrationId: string;
    name: string;
    email: string | null;
    registrationType: string | null;
    surveyAnsweredAt: string;
  }>;
}

/** The recipients report: who is assigned what, and where each person stands. */
export function useCertificateRecipients(eventId: string, enabled = true) {
  return useQuery({
    queryKey: ["events", eventId, "certificates", "recipients"],
    queryFn: () => fetchApi<CertificateRecipientsReport>(`/api/events/${eventId}/certificates/recipients`),
    enabled,
    // People answer the survey and certificates go out while the page is open.
    staleTime: 30 * 1000,
  });
}

/** List an event's certificate templates (for the single-issue picker). */
export function useCertificateTemplates(eventId: string, enabled = true) {
  return useQuery({
    queryKey: ["events", eventId, "certificates", "templates"],
    queryFn: () => fetchApi<{ templates: CertTemplateOption[] }>(`/api/events/${eventId}/certificates/templates`),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

/** Issue one certificate template to ONE registration or speaker on demand. */
export function useIssueSingleCertificate(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { templateIds: string[]; registrationId?: string; speakerId?: string; sendEmail?: boolean }) =>
      fetchApi<{
        ok: true;
        recipientEmail: string;
        /** One entry per cert in the bundle email; `reused` = already held, re-attached. */
        certs: Array<{ certificateId: string; serial: string; templateName: string; reused: boolean }>;
        /** Templates that couldn't be materialized (partial send when non-empty). */
        failures: Array<{ templateId: string; templateName: string; error: string }>;
        /** False when the operator chose "issue only" (no delivery email sent). */
        emailed: boolean;
      }>(
        `/api/events/${eventId}/certificates/issue-single`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["events", eventId, "certificates", "issued"],
      });
      queryClient.invalidateQueries({ queryKey: ["email-logs"] });
    },
  });
}
