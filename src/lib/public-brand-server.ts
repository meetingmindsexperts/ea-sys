/**
 * The attendee-facing brand for this request's address (src/lib/public-brand.ts).
 * Only the brand leaves: the settings JSON also holds encrypted credentials.
 */
import { cache } from "react";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";
import { NO_ORGANISATION_BRAND, readPublicBrand, type PublicBrand } from "@/lib/public-brand";

export const loadPublicBrandForHost = cache(async (host: string | null): Promise<PublicBrand> => {
  try {
    const tenant = await resolveTenantOrg(normalizeHost(host));
    if (!tenant.orgId) return NO_ORGANISATION_BRAND;
    return await loadPublicBrandForOrg(tenant.orgId);
  } catch (err) {
    apiLogger.warn({ err, msg: "public-brand:load-failed", host });
    return NO_ORGANISATION_BRAND;
  }
});

export async function loadPublicBrandForOrg(orgId: string): Promise<PublicBrand> {
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { name: true, logo: true, settings: true } });
  return org ? readPublicBrand(org.settings, org) : NO_ORGANISATION_BRAND;
}

/** The organisation's own name and logo, for the staff door. */
export const loadStaffBrandForHost = cache(async (host: string | null): Promise<PublicBrand> => {
  try {
    const tenant = await resolveTenantOrg(normalizeHost(host));
    if (!tenant.orgId) return NO_ORGANISATION_BRAND;
    const org = await db.organization.findUnique({ where: { id: tenant.orgId }, select: { name: true, logo: true } });
    return org ?? NO_ORGANISATION_BRAND;
  } catch (err) {
    apiLogger.warn({ err, msg: "staff-brand:load-failed", host });
    return NO_ORGANISATION_BRAND;
  }
});
