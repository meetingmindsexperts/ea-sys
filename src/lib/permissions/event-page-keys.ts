import type { PermissionKey } from "./catalogue";

/**
 * The key that opens each event page, by the first path segment after
 * `/events/[eventId]/` (custom roles Phase 3, Oct 5, 2026). It is the key the
 * page's own list GET asks, so a person the page would refuse sees the shared
 * "no access" panel instead of a page full of failed requests. A segment
 * missing here is not gated (overview, setup, readiness, settings, content,
 * my-details); the event itself still is. Advisory: the routes decide.
 *
 * Pinned by __tests__/permissions/event-page-keys.test.ts: every system role
 * that could open a page before keeps it, and every route key named here is
 * the one the route asks.
 */
export const EVENT_PAGE_KEYS: Readonly<Record<string, PermissionKey>> = {
  abstracts: "abstracts.read",
  accommodation: "accommodation.read",
  agenda: "sessions.read",
  agent: "agent.use",
  analytics: "analytics.read",
  certificates: "certificates.read",
  "check-in": "registrations.read",
  communications: "templates.read",
  dinner: "rsvp.manage",
  "email-templates": "templates.read",
  export: "events.export",
  imports: "analytics.read",
  invoices: "invoices.read",
  media: "media.manage",
  "promo-codes": "promo.read",
  registrations: "registrations.read",
  reimbursements: "reimbursements.manage",
  reviewers: "reviewers.pool.manage",
  rsvp: "rsvp.manage",
  "session-proposals": "proposals.read",
  speakers: "speakers.read",
  sponsors: "sponsors.read",
  survey: "surveys.read",
  tickets: "tickets.read",
  "travel-grants": "travelGrants.manage",
  webinar: "webinar.analytics.read",
};

/** The page segment of an event path: `/events/e1/speakers/s1` → `speakers`. */
export function eventPageSegment(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts[0] === "events" ? parts[2] ?? "" : "";
}
