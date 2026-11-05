import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { requireOrgId } from "@/lib/require-org";
import { resolveActingOrgId } from "@/lib/platform-operator";
import { requirePermission } from "@/lib/permissions/require-permission";
import { updateEventSettings, updateOrganizationSettings } from "@/lib/event-settings";
import {
  CATALOGUE_SECTIONS,
  CATALOGUE_SETTING,
  CATALOGUE_TEXT_LIMITS as L,
  isCatalogueHeroImageUrl,
  readCatalogueSettings,
} from "@/lib/catalogue";

/**
 * The Settings, Catalogue tab (Nov 5, 2026): every control the organisation
 * has over its public catalogue, in `Organization.settings.catalogue`, and the
 * switch that lists each event (`Event.settings.showInCatalogue`, the same
 * switch as the event's own Settings, Registration tab).
 *
 *   GET    the settings, the defaults the page falls back to, and the events
 *   PUT    save the settings (org.settings)
 *   PATCH  list or unlist one event (events.settings on that event)
 */

const text = (max: number) => z.string().trim().max(max).nullable().optional();

const catalogueSchema = z
  .object({
    heroImage: z.string().refine(isCatalogueHeroImageUrl, "Must be a media library upload or an https address").nullable().optional(),
    eyebrow: text(L.eyebrow),
    headline: text(L.headline),
    intro: text(L.intro),
    footerAbout: text(L.footerAbout),
    // Trimmed first, so a field of spaces clears rather than failing as an address.
    contactEmail: z
      .string()
      .trim()
      .max(L.contactEmail)
      .refine((v) => v === "" || z.string().email().safeParse(v).success, "Must be an email address")
      .nullable()
      .optional(),
    contactPhone: text(L.contactPhone),
    showStats: z.boolean().optional(),
    showBannerFan: z.boolean().optional(),
    showNextUp: z.boolean().optional(),
    showHowItWorks: z.boolean().optional(),
    showTopics: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<Partial<Record<(typeof CATALOGUE_SECTIONS)[number], boolean>>>;

const listingSchema = z.object({ eventId: z.string().min(1).max(64), listed: z.boolean() }).strict();

/** The statuses a catalogue can show: drafts and cancelled events never list. */
const LISTABLE = ["PUBLISHED", "LIVE", "COMPLETED"] as const;

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "org.settings", { route: "organization/catalogue:GET" });
    if (!gate.ok) return gate.response;
    const guard = requireOrgId(session, { route: "organization/catalogue:GET" });
    if ("error" in guard) return guard.error;
    // A platform operator may act on another organisation, as on /api/organization.
    const org = { orgId: resolveActingOrgId(req, session.user, guard.orgId, { route: "organization/catalogue:GET" }) };

    const [row, events] = await Promise.all([
      db.organization.findUnique({ where: { id: org.orgId }, select: { name: true, settings: true, companyEmail: true, companyPhone: true } }),
      db.event.findMany({
        where: { organizationId: org.orgId, status: { in: [...LISTABLE] } },
        orderBy: { startDate: "desc" },
        take: 200,
        select: { id: true, name: true, slug: true, status: true, startDate: true, endDate: true, city: true, country: true, settings: true },
      }),
    ]);
    if (!row) {
      apiLogger.warn({ orgId: org.orgId, msg: "organization/catalogue:GET org-not-found" });
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    return NextResponse.json({
      settings: readCatalogueSettings(row.settings),
      // What an empty field falls back to, for the form's placeholders.
      defaults: { organizationName: row.name, companyEmail: row.companyEmail, companyPhone: row.companyPhone },
      // Only the listing switch leaves the settings JSON.
      events: events.map(({ settings, ...e }) => ({
        ...e,
        listed: (settings as { showInCatalogue?: unknown } | null)?.showInCatalogue === true,
      })),
    });
  } catch (err) {
    apiLogger.error({ err, msg: "organization/catalogue:GET failed" });
    return NextResponse.json({ error: "Failed to load the catalogue settings" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "org.settings", { route: "organization/catalogue:PUT" });
    if (!gate.ok) return gate.response;
    const guard = requireOrgId(session, { route: "organization/catalogue:PUT" });
    if ("error" in guard) return guard.error;
    // A platform operator may act on another organisation, as on /api/organization.
    const org = { orgId: resolveActingOrgId(req, session.user, guard.orgId, { route: "organization/catalogue:PUT" }) };

    const parsed = catalogueSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      apiLogger.warn({ msg: "organization/catalogue:PUT invalid", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    // Merged over what is stored, field by field, so a partial save (or a
    // second admin saving another field) never wipes the rest. Blank is null;
    // readCatalogueSettings fills every default on the way out.
    const stored = Object.fromEntries(Object.entries(parsed.data).map(([k, v]) => [k, v === "" ? null : v]));
    const merged = await updateOrganizationSettings(org.orgId, (cur) => {
      const current = cur[CATALOGUE_SETTING];
      return { ...cur, [CATALOGUE_SETTING]: { ...(current && typeof current === "object" ? current : {}), ...stored } };
    });

    await db.auditLog.create({
      data: {
        userId: session.user.id,
        organizationId: org.orgId,
        action: "UPDATE",
        entityType: "Organization",
        entityId: org.orgId,
        changes: { catalogue: stored, ip: getClientIp(req) },
      },
    });
    apiLogger.info({ orgId: org.orgId, userId: session.user.id, msg: "organization/catalogue:PUT saved" });
    return NextResponse.json({ settings: readCatalogueSettings(merged) });
  } catch (err) {
    apiLogger.error({ err, msg: "organization/catalogue:PUT failed" });
    return NextResponse.json({ error: "Failed to save the catalogue settings" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const parsed = listingSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      apiLogger.warn({ msg: "organization/catalogue:PATCH invalid", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const { eventId, listed } = parsed.data;
    // The event's own settings key, on that event: the same door as its
    // Settings, Registration tab.
    const gate = requirePermission(session, "events.settings", { route: "organization/catalogue:PATCH", eventId });
    if (!gate.ok) return gate.response;
    const guard = requireOrgId(session, { route: "organization/catalogue:PATCH", eventId });
    if ("error" in guard) return guard.error;
    // A platform operator may act on another organisation, as on /api/organization.
    const org = { orgId: resolveActingOrgId(req, session.user, guard.orgId, { route: "organization/catalogue:PATCH" }) };

    const event = await db.event.findFirst({ where: { AND: [gate.eventWhere, { id: eventId, organizationId: org.orgId }] }, select: { id: true, status: true } });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id, msg: "organization/catalogue:PATCH event-not-found" });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (listed && !(LISTABLE as readonly string[]).includes(event.status)) {
      apiLogger.warn({ eventId, status: event.status, msg: "organization/catalogue:PATCH not-listable" });
      return NextResponse.json({ error: "Only a published event can be listed" }, { status: 409 });
    }

    await updateEventSettings(event.id, (cur) => ({ ...cur, showInCatalogue: listed }), { organizationId: org.orgId });
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        organizationId: org.orgId,
        eventId: event.id,
        action: "UPDATE",
        entityType: "Event",
        entityId: event.id,
        changes: { showInCatalogue: listed, source: "catalogue-settings", ip: getClientIp(req) },
      },
    });
    apiLogger.info({ eventId, listed, userId: session.user.id, msg: "organization/catalogue:PATCH listing-changed" });
    return NextResponse.json({ eventId: event.id, listed });
  } catch (err) {
    apiLogger.error({ err, msg: "organization/catalogue:PATCH failed" });
    return NextResponse.json({ error: "Failed to change the listing" }, { status: 500 });
  }
}
