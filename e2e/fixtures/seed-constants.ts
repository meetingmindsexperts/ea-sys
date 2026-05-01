/**
 * Fixed values shared by the E2E seed script and specs so they can't drift.
 * Do not import outside e2e/ or prisma/.
 */

export const ORG_ID = "e2e-org";
export const EVENT_ID = "e2e-event-id";
export const EVENT_SLUG = "e2e-event";
export const FREE_TICKET_TYPE_ID = "e2e-ticket-free";
export const PAID_TICKET_TYPE_ID = "e2e-ticket-paid";
export const FREE_PRICING_TIER_ID = "e2e-tier-free";

// Slugified PricingTier.name — matches toSlug() in
// src/app/e/[slug]/register/[category]/page.tsx (the category URL segment is
// derived from the pricing-tier name when tiers exist, otherwise from
// TicketType.category).
export const FREE_CATEGORY_SLUG = "free-pass";

export const DEFAULT_PASSWORD = "password123";

export const USERS = [
  { role: "ADMIN", email: "admin@test.local", firstName: "Alex", lastName: "Admin" },
  { role: "ORGANIZER", email: "organizer@test.local", firstName: "Olga", lastName: "Organizer" },
  { role: "REVIEWER", email: "reviewer@test.local", firstName: "Riley", lastName: "Reviewer" },
  { role: "SUBMITTER", email: "submitter@test.local", firstName: "Sam", lastName: "Submitter" },
  { role: "REGISTRANT", email: "registrant@test.local", firstName: "Reg", lastName: "Registrant" },
] as const;

export type SeedRole = typeof USERS[number]["role"];

export function userFor(role: SeedRole) {
  const found = USERS.find((u) => u.role === role);
  if (!found) throw new Error(`Unknown seed role: ${role}`);
  return found;
}

// ── Docs-only fixtures (used by the screenshot seed, not the regression e2e seed)
export const DOCS_SESSION_ID = "e2e-session-keynote";
export const DOCS_TRACK_ID = "e2e-track-clinical";
export const DOCS_ABSTRACT_ID = "e2e-abstract-1";
export const DOCS_HOTEL_ID = "e2e-hotel-marriott";
export const DOCS_ROOM_TYPE_ID = "e2e-room-deluxe";
export const DOCS_WEBINAR_EVENT_ID = "e2e-webinar-event";
export const DOCS_WEBINAR_SLUG = "e2e-webinar";
