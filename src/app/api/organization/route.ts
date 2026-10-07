import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { resolveActingOrgId } from "@/lib/platform-operator";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { updateOrganizationSettings } from "@/lib/event-settings";
import { can } from "@/lib/permissions/can";
import { principalFromSession, requirePermission } from "@/lib/permissions/require-permission";

const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  logo: z.string().max(500).nullable().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #00aade").nullable().optional(),
  settings: z.object({
    timezone: z.string().max(100).optional(),
    dateFormat: z.string().max(50).optional(),
    currency: z.string().max(10).optional(),
    emailNotifications: z.boolean().optional(),
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
const ORG_GENERAL_SETTINGS = ["timezone", "dateFormat", "currency", "emailNotifications"] as const;

export async function GET(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Reading ANOTHER org is a platform-operator action, not an org-admin one.
    const orgId = resolveActingOrgId(req, session.user, session.user.organizationId!, {
      route: "organization:GET",
    });

    // Exactly what the Settings screens show, nothing more (Phase 6 review,
    // Oct 7, 2026). Any signed-in account in the org reaches this GET, and it
    // used to return the whole row: the `settings` JSON with the encrypted
    // Zoom, Stripe and AI credentials, and the staff list with emails, which
    // `users.read` otherwise restricts.
    const row = await db.organization.findUnique({
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
    });

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
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
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

    // Get current organization to merge settings
    const currentOrg = await db.organization.findUnique({
      where: { id: orgId },
    });

    if (!currentOrg) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    // Settings merge goes through the atomic read-merge-write helper so a
    // concurrent settings writer (zoom/eventsAir credentials, …) can't be
    // clobbered. Scalar columns stay on the organization.update below.
    if (settings) {
      const cleanSettings = JSON.parse(JSON.stringify(settings));
      await updateOrganizationSettings(orgId, cleanSettings);
    }

    const organization = await db.organization.update({
      where: { id: orgId },
      data: {
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
      },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        organizationId: organization.id,
        action: "UPDATE",
        entityType: "Organization",
        entityId: organization.id,
        changes: { ...validated.data, ip: getClientIp(req) },
      },
    });

    return NextResponse.json(organization);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating organization" });
    return NextResponse.json(
      { error: "Failed to update organization" },
      { status: 500 }
    );
  }
}
