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

// Per container, a minute: every page render reads the brand (the root layout's
// tab title), and a Settings change showing within a minute is fine.
const BRAND_TTL_MS = 60_000;
const brandCache = new Map<string, { brand: PublicBrand; at: number }>();

/**
 * Never throws: the brand is wording, and a failed lookup must not cancel the
 * email or the reviewer invitation it decorates. A failure is not cached.
 */
export async function loadPublicBrandForOrg(orgId: string): Promise<PublicBrand> {
  const hit = brandCache.get(orgId);
  if (hit && Date.now() - hit.at < BRAND_TTL_MS) return hit.brand;
  try {
    const org = await db.organization.findUnique({ where: { id: orgId }, select: { name: true, logo: true, settings: true } });
    const brand = org ? readPublicBrand(org.settings, org) : NO_ORGANISATION_BRAND;
    brandCache.set(orgId, { brand, at: Date.now() });
    return brand;
  } catch (err) {
    apiLogger.warn({ err, msg: "public-brand:org-load-failed", orgId });
    return NO_ORGANISATION_BRAND;
  }
}

/** The organisation's own name and logo: what staff see (the dashboard's tab title). */
export const loadStaffBrandForHost = cache(async (host: string | null): Promise<PublicBrand> => {
  try {
    const tenant = await resolveTenantOrg(normalizeHost(host));
    if (!tenant.orgId) return NO_ORGANISATION_BRAND;
    return await loadOrgOwnBrand(tenant.orgId);
  } catch (err) {
    apiLogger.warn({ err, msg: "staff-brand:load-failed", host });
    return NO_ORGANISATION_BRAND;
  }
});

const ownBrandCache = new Map<string, { brand: PublicBrand; at: number }>();

async function loadOrgOwnBrand(orgId: string): Promise<PublicBrand> {
  const hit = ownBrandCache.get(orgId);
  if (hit && Date.now() - hit.at < BRAND_TTL_MS) return hit.brand;
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { name: true, logo: true } });
  const brand = org ?? NO_ORGANISATION_BRAND;
  ownBrandCache.set(orgId, { brand, at: Date.now() });
  return brand;
}

/** After Settings saves: this container shows the new brand at once (others within a minute). */
export function forgetBrand(orgId: string): void {
  brandCache.delete(orgId);
  ownBrandCache.delete(orgId);
}
