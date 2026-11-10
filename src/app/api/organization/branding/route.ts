import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveActingOrgId } from "@/lib/platform-operator";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { isTeamRole } from "@/lib/team-roles";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { NO_ORGANISATION_BRAND, readPublicBrand } from "@/lib/public-brand";
import { loadPublicBrandForOrg } from "@/lib/public-brand-server";

const EMPTY = { name: null, logo: null, primaryColor: null, publicName: NO_ORGANISATION_BRAND.name, publicLogo: null };

export async function GET(req: Request) {
  try {
    const session = await auth();
    // Attendees, authors and reviewers are org-null; the address names the
    // organisation whose attendee-facing brand they see (public-brand.ts).
    if (!session?.user?.organizationId || !isTeamRole(session.user.role)) {
      const orgId = session?.user?.organizationId ?? (await resolveRequestOrgId(req));
      if (!orgId) return NextResponse.json(EMPTY);
      const brand = await loadPublicBrandForOrg(orgId);
      return NextResponse.json({ ...EMPTY, publicName: brand.name, publicLogo: brand.logo });
    }

    const orgId = resolveActingOrgId(req, session.user, session.user.organizationId, {
      route: "organization:branding",
    });

    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { name: true, logo: true, primaryColor: true, settings: true },
    });
    const brand = org ? readPublicBrand(org.settings, org) : NO_ORGANISATION_BRAND;

    return NextResponse.json({
      name: org?.name ?? null,
      logo: org?.logo ?? null,
      primaryColor: org?.primaryColor ?? null,
      publicName: brand.name,
      publicLogo: brand.logo,
    });
  } catch (err) {
    // Non-fatal: fall back to empty branding, but never swallow silently.
    apiLogger.warn({ err, msg: "organization/branding:get-failed" });
    return NextResponse.json(EMPTY);
  }
}
