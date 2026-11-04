import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";
import { publicOrgScopeForHost } from "@/lib/public-event";
import { catalogueBaseWhere } from "@/lib/catalogue";

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
 * past, sorted. These are the topic pages that exist; anything else 404s.
 */
export async function listTopicValues(orgScope: { organizationId?: string }) {
  const where = catalogueBaseWhere(orgScope);
  const [specialties, countries] = await Promise.all([
    db.event.findMany({ where: { ...where, specialty: { not: null } }, distinct: ["specialty"], select: { specialty: true } }),
    db.event.findMany({ where: { ...where, country: { not: null } }, distinct: ["country"], select: { country: true } }),
  ]);
  const clean = (values: (string | null)[]) => [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v))].sort();
  return { specialties: clean(specialties.map((s) => s.specialty)), countries: clean(countries.map((c) => c.country)) };
}
