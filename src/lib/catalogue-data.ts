import { readPublicBrand } from "@/lib/public-brand";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";
import { publicOrgScopeForHost } from "@/lib/public-event";
import { catalogueBaseWhere, groupTopics, readCatalogueSettings, type CatalogueSettings, type Topic } from "@/lib/catalogue";
import { eventIsFull } from "@/lib/public-availability";
import { publicRegistration, ratesByType, type PublicOffer, type RegistrationState, type TypeRate } from "@/lib/event-overview";

/**
 * Server-side reads shared by the catalogue and its topic pages (Nov 4,
 * 2026): which organisation this site is, and which specialties and countries
 * have listed events. The pure rules are in src/lib/catalogue.ts.
 */

/** The columns a catalogue card shows. */
export const CATALOGUE_EVENT_SELECT = {
  id: true,
  slug: true,
  name: true,
  startDate: true,
  endDate: true,
  timezone: true,
  venue: true,
  city: true,
  country: true,
  eventType: true,
  specialty: true,
  bannerImage: true,
  bannerImageMobile: true,
  cmeHours: true,
} satisfies Prisma.EventSelect;

export type CatalogueEvent = Prisma.EventGetPayload<{ select: typeof CATALOGUE_EVENT_SELECT }>;

export interface SiteOrganization {
  name: string;
  logo: string | null;
  /** Everything set in Settings, Catalogue, with the defaults filled in. */
  catalogue: CatalogueSettings;
  /** The public contact: the Catalogue tab's, else the company details (Billing). */
  email: string | null;
  phone: string | null;
}

/** This site's organisation (by host) and the scope every public listing query starts from. */
export async function loadSiteContext(host: string | null) {
  const [orgScope, tenant] = await Promise.all([publicOrgScopeForHost(host), resolveTenantOrg(normalizeHost(host))]);
  const row = tenant.orgId
    ? await db.organization.findUnique({
        where: { id: tenant.orgId },
        select: { name: true, logo: true, settings: true, companyEmail: true, companyPhone: true },
      })
    : null;
  // Only the named fields leave this function: the settings JSON also holds
  // encrypted credentials and must never reach a page.
  const catalogue = row && readCatalogueSettings(row.settings);
  // The attendee-facing brand, not the organisation's own name (public-brand.ts).
  const brand = row && readPublicBrand(row.settings, row);
  const organization: SiteOrganization | null = row && catalogue && brand && {
    name: brand.name,
    logo: brand.logo,
    catalogue,
    email: catalogue.contactEmail ?? row.companyEmail,
    phone: catalogue.contactPhone ?? row.companyPhone,
  };
  return { orgScope, organization };
}

/** What the catalogue hero states about the organisation; every number is counted, never typed in. */
export interface SiteStats {
  events: number;
  delegates: number;
  faculty: number;
  countries: number;
}

const RUN_STATUSES = ["PUBLISHED", "LIVE", "COMPLETED"] as const;

// The numbers move by a few a day and every public view (crawlers included)
// would otherwise count the org's whole history, so each container keeps
// them for ten minutes per organisation.
const STATS_TTL_MS = 10 * 60 * 1000;
const statsCache = new Map<string, { stats: SiteStats; at: number }>();

/**
 * The organisation's track record on this platform: events run (listed or
 * not, drafts and cancelled never), delegates registered (not cancelled, the
 * hidden Faculty type excluded, as every delegate count is), faculty counted
 * once per person by email, and countries.
 */
export async function loadSiteStats(orgScope: { organizationId?: string }): Promise<SiteStats> {
  const key = orgScope.organizationId ?? "*";
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.stats;
  const stats = await countSiteStats(orgScope);
  statsCache.set(key, { stats, at: Date.now() });
  return stats;
}

async function countSiteStats(orgScope: { organizationId?: string }): Promise<SiteStats> {
  const eventWhere = { ...orgScope, status: { in: [...RUN_STATUSES] } };
  const [events, countries, delegates, faculty] = await Promise.all([
    db.event.count({ where: eventWhere }),
    db.event.groupBy({ by: ["country"], where: { ...eventWhere, country: { not: null } } }),
    db.registration.count({ where: { event: eventWhere, status: { notIn: ["CANCELLED", "WAITLISTED"] }, ticketType: { isFaculty: false } } }),
    db.speaker.groupBy({ by: ["email"], where: { event: eventWhere } }),
  ]);
  const countryCount = new Set(countries.map((c) => c.country?.trim().toLowerCase()).filter(Boolean)).size;
  // One person per address however it was typed ("A@x.com" and "a@x.com").
  const people = new Set(faculty.map((f) => f.email.trim().toLowerCase())).size;
  return { events, delegates, faculty: people, countries: countryCount };
}

export interface CardRegistration {
  state: RegistrationState;
  offer: PublicOffer | null;
  /** The rate the Register link lands on ("Early Bird"), when open. */
  rate: string | null;
  rates: TypeRate[];
}

/**
 * Each event's registration state and prices, by the one public rule
 * (public-availability.ts via event-overview.ts): a card never says "Early
 * bird" or "From $200" when the form would say closed or full.
 */
export async function loadCardRegistration(eventIds: string[], now: Date): Promise<Map<string, CardRegistration>> {
  if (eventIds.length === 0) return new Map();
  const rows = await db.event.findMany({
    where: { id: { in: eventIds } },
    select: {
      id: true, endDate: true, eventType: true, settings: true, maxAttendees: true, seatCount: true,
      ticketTypes: {
        // What the public form sells: active, never the hidden Faculty type.
        where: { isActive: true, isFaculty: false },
        orderBy: { sortOrder: "asc" },
        select: {
          name: true, quantity: true, soldCount: true,
          pricingTiers: {
            where: { isActive: true },
            orderBy: { sortOrder: "asc" },
            select: { name: true, sortOrder: true, price: true, currency: true, quantity: true, soldCount: true, salesStart: true, salesEnd: true },
          },
        },
      },
    },
  });
  return new Map(
    rows.map((e) => {
      const settings = (e.settings ?? {}) as Record<string, unknown>;
      const input = {
        endDate: e.endDate,
        registrationOpen: settings.registrationOpen !== false,
        eventFull: eventIsFull(e),
        eventType: e.eventType,
        settings,
        ticketTypes: e.ticketTypes,
      };
      return [e.id, { ...publicRegistration(input, now), ...ratesByType(input, now) }];
    }),
  );
}

/**
 * Every specialty and country with at least one listed event, upcoming or
 * past, as topics (grouped by slug, every stored spelling kept). These are
 * the topic pages that exist; anything else 404s.
 */
export async function listTopicValues(orgScope: { organizationId?: string }): Promise<{ specialties: Topic[]; countries: Topic[] }> {
  const where = catalogueBaseWhere(orgScope);
  const [specialties, countries] = await Promise.all([
    db.event.groupBy({ by: ["specialty"], where: { ...where, specialty: { not: null } }, _count: { _all: true } }),
    db.event.groupBy({ by: ["country"], where: { ...where, country: { not: null } }, _count: { _all: true } }),
  ]);
  return {
    specialties: groupTopics(specialties.map((r) => ({ value: r.specialty, count: r._count._all }))),
    countries: groupTopics(countries.map((r) => ({ value: r.country, count: r._count._all }))),
  };
}
