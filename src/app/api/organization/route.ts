import { forgetBrand } from "@/lib/public-brand-server";
import { PUBLIC_BRAND_SETTINGS_KEY, publicBrandSettingsSchema } from "@/lib/public-brand";
import { SUPPORT_CONTACT_SETTING, storedSupportContact, supportContactSchema } from "@/lib/support-contact";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { resolveActingOrgId } from "@/lib/platform-operator";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { updateOrganizationSettings } from "@/lib/event-settings";
import { can } from "@/lib/permissions/can";
import { DEFAULT_REG_TYPES_SETTING, defaultRegistrationTypesSchema } from "@/lib/default-registration-types";
import { principalFromSession, requirePermission } from "@/lib/permissions/require-permission";
import { exitLinkField } from "@/lib/webinar-exit-link";

const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  logo: z.string().max(500).nullable().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #00aade").nullable().optional(),
  settings: z.object({
    timezone: z.string().max(100).optional(),
    dateFormat: z.string().max(50).optional(),
    currency: z.string().max(10).optional(),
    emailNotifications: z.boolean().optional(),
    // The registration types a NEW event starts with; [] = none. Read only at
    // event creation (event-service), never by existing events.
    defaultRegistrationTypes: defaultRegistrationTypesSchema.optional(),
    // The organisation's website: the exit button on every webinar's thank-you
    // screen unless the webinar sets its own (Nov 5, 2026). "" clears it.
    website: exitLinkField.optional(),
    // The name and logo HCPs see (src/lib/public-brand.ts); empty halves fall back to the organisation's.
    publicBrand: publicBrandSettingsSchema.optional(),
    // The phone and office hours every event's team answers on, unless an event
    // gives its own (src/lib/support-contact.ts). "" clears a field.
    supportContact: supportContactSchema.optional(),
  }).optional(),
  // Billing / Invoice fields
  companyName: z.string().max(255).nullable().optional(),
  companyAddress: z.string().max(1000).nullable().optional(),
  companyCity: z.string().max(255).nullable().optional(),
  companyState: z.string().max(255).nullable().optional(),
  companyZipCode: z.string().max(50).nullable().optional(),
  companyCountry: z.string().max(255).nullable().optional(),
  companyPhone: z.string().max(50).nullable().optional(),
  companyEmail: z.string().email().max(255).nullable().optional(),
  taxId: z.string().max(100).nullable().optional(),
  invoicePrefix: z.string().max(10).nullable().optional(),
});

/** The organisation preferences the Settings screen reads and any staff member may see. */
const ORG_GENERAL_SETTINGS = [PUBLIC_BRAND_SETTINGS_KEY, "timezone", "dateFormat", "currency", "emailNotifications", DEFAULT_REG_TYPES_SETTING, "website", SUPPORT_CONTACT_SETTING] as const;

export async function GET(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Reading ANOTHER org is a platform-operator action, not an org-admin one.
    // The override is asked FIRST: an operator may have no organisation of
    // their own and still name one to read.
    const orgId = resolveActingOrgId(req, session.user, session.user.organizationId ?? "", {
      route: "organization:GET",
    });
    // An account with no organisation that names none (a reviewer, submitter
    // or registrant) has nothing to read. It used to reach Prisma with a null
    // id and answer 500 (found by the route smoke test, Nov 17, 2026).
    if (!orgId) {
      apiLogger.warn({ msg: "organization:GET:no-organization", userId: session.user.id, role: session.user.role });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Exactly what the Settings screens show, nothing more (Phase 6 review,
    // Oct 7, 2026). Any signed-in account in the org reaches this GET, and it
    // used to return the whole row: the `settings` JSON with the encrypted
    // Zoom, Stripe and AI credentials, and the staff list with emails, which
    // `users.read` otherwise restricts.
    // Inside the organisation's lane (review of 9c0a24c5): the event count under the
    // organisation is a read of Event, which carries a row policy, and outside a lane
    // it came back 0 on the platform while the organisation itself was found.
    const row = await runWithTenant(orgId, () =>
      db.organization.findUnique({
        where: { id: orgId },
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          primaryColor: true,
          settings: true,
          companyName: true,
          companyAddress: true,
          companyCity: true,
          companyState: true,
          companyZipCode: true,
          companyCountry: true,
          companyPhone: true,
          companyEmail: true,
          taxId: true,
          invoicePrefix: true,
          createdAt: true,
          _count: { select: { events: true, users: true } },
        },
      }),
    );

    if (!row) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }
    // Only the general preferences; every credential and integration key stays on the server.
    const stored = (row.settings && typeof row.settings === "object" ? row.settings : {}) as Record<string, unknown>;
    const settings = Object.fromEntries(
      ORG_GENERAL_SETTINGS.filter((k) => k in stored).map((k) => [k, stored[k]]),
    );
    // Company and tax details only for the people whose screens use them (the
    // Billing card: billingAccounts.manage, or org.settings); any other account
    // in the org, an internal registrant included, gets the profile alone
    // (review of 0875035c, Oct 7, 2026).
    const principal = principalFromSession(session);
    const seesBilling = can(principal, "org.settings") || can(principal, "billingAccounts.manage");
    const { companyName, companyAddress, companyCity, companyState, companyZipCode, companyCountry, companyPhone, companyEmail, taxId, invoicePrefix, ...profile } = row;
    const billing = { companyName, companyAddress, companyCity, companyState, companyZipCode, companyCountry, companyPhone, companyEmail, taxId, invoicePrefix };
    const organization = { ...profile, ...(seesBilling ? billing : {}), settings };

    return NextResponse.json(organization);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching organization" });
    return NextResponse.json(
      { error: "Failed to fetch organization" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only admins can update organization settings
    const gate = requirePermission(session, "org.settings", { route: "organization:PUT" });
    if (!gate.ok) return gate.response;

    const body = await req.json();
    const validated = updateOrganizationSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "organization:zod-validation-failed", errors: validated.error.flatten() });
      // The starting list of registration types has rules a person must be
      // told in words (a reserved name, a duplicate): say which one.
      const listIssue = validated.error.issues.find((i) => i.path[0] === "settings" && i.path[1] === DEFAULT_REG_TYPES_SETTING);
      return NextResponse.json(
        { error: listIssue?.message ?? "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const {
      name, logo, primaryColor, settings,
      companyName, companyAddress, companyCity, companyState,
      companyZipCode, companyCountry, companyPhone, companyEmail,
      taxId, invoicePrefix,
    } = validated.data;

    // The most dangerous of the six override sites: this id goes straight into
    // `organization.update({ where: { id: orgId } })`, so an un-gated override
    // is a cross-tenant WRITE, not just a read.
    const orgId = resolveActingOrgId(req, session.user, session.user.organizationId!, {
      route: "organization:PUT",
    });

    // The organisation must exist (its id only: the row's settings hold credentials).
    const currentOrg = await db.organization.findUnique({
      where: { id: orgId },
      select: { id: true },
    });

    if (!currentOrg) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    const columns = {
      ...(name && { name }),
      ...(logo !== undefined && { logo }),
      ...(primaryColor !== undefined && { primaryColor }),
      ...(companyName !== undefined && { companyName }),
      ...(companyAddress !== undefined && { companyAddress }),
      ...(companyCity !== undefined && { companyCity }),
      ...(companyState !== undefined && { companyState }),
      ...(companyZipCode !== undefined && { companyZipCode }),
      ...(companyCountry !== undefined && { companyCountry }),
      ...(companyPhone !== undefined && { companyPhone }),
      ...(companyEmail !== undefined && { companyEmail }),
      ...(taxId !== undefined && { taxId }),
      ...(invoicePrefix !== undefined && { invoicePrefix }),
    };

    // Settings and columns in ONE locked update (review of d3e669030: the
    // settings went first in their own transaction, so a failed column write
    // left half a save). The locked read-merge-write keeps a concurrent
    // settings writer (zoom/eventsAir credentials, ...) from being clobbered.
    if (settings) {
      const cleanSettings = JSON.parse(JSON.stringify(settings));
      if (settings.supportContact !== undefined) cleanSettings[SUPPORT_CONTACT_SETTING] = storedSupportContact(settings.supportContact);
      await updateOrganizationSettings(orgId, cleanSettings, { columns });
    } else {
      await db.organization.update({ where: { id: orgId }, data: columns });
    }

    forgetBrand(orgId);

    // Log the action. Inside the organisation's lane: under row security an
    // insert naming an organisation outside its lane throws AFTER the save has
    // committed, and the caller was told it failed (review of d78d5ca60; the
    // event route fixed the same on Nov 18). A failed audit row is logged,
    // never turned into "Failed to update" for a save that happened.
    await runWithTenant(orgId, () =>
      db.auditLog.create({
        data: {
          userId: session.user.id,
          organizationId: orgId,
          action: "UPDATE",
          entityType: "Organization",
          entityId: orgId,
          changes: { ...validated.data, ip: getClientIp(req) },
        },
      }),
    ).catch((err) => apiLogger.error({ err, organizationId: orgId, msg: "organization:PUT audit-log-failed" }));

    // The saved profile, never the row: the row's settings hold every encrypted
    // credential (Zoom, Stripe, AI, DET, EventsAir), which the GET was trimmed
    // of on Oct 7, 2026 and this answer still carried (review of d3e669030).
    // No caller reads the body; it is what a client may show.
    const saved = await db.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true, slug: true, logo: true, primaryColor: true } });
    return NextResponse.json(saved);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating organization" });
    return NextResponse.json(
      { error: "Failed to update organization" },
      { status: 500 }
    );
  }
}
