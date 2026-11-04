import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";
import { publicOrgScopeForHost } from "@/lib/public-event";
import { catalogueBaseWhere, groupTopics, type Topic } from "@/lib/catalogue";

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

/** This site's organisation (by host) and the scope every public listing query starts from. */
export async function loadSiteContext(host: string | null) {
  const [orgScope, tenant] = await Promise.all([publicOrgScopeForHost(host), resolveTenantOrg(normalizeHost(host))]);
  const organization = tenant.orgId
    ? await db.organization.findUnique({ where: { id: tenant.orgId }, select: { name: true, logo: true } })
    : null;
  return { orgScope, organization };
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
