import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";

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

export async function GET(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // SUPER_ADMIN can view any org via x-org-id header
    let orgId = session.user.organizationId!;
    if (session.user.role === "SUPER_ADMIN") {
      const overrideOrgId = req.headers.get("x-org-id");
      if (overrideOrgId) orgId = overrideOrgId;
    }

    const organization = await db.organization.findUnique({
      where: { id: orgId },
      include: {
        users: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
            createdAt: true,
          },
        },
        _count: {
          select: {
            events: true,
            users: true,
          },
        },
      },
    });

    if (!organization) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

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
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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

    // SUPER_ADMIN can update any org via x-org-id header
    let orgId = session.user.organizationId!;
    if (session.user.role === "SUPER_ADMIN") {
      const overrideOrgId = req.headers.get("x-org-id");
      if (overrideOrgId) orgId = overrideOrgId;
    }

    // Get current organization to merge settings
    const currentOrg = await db.organization.findUnique({
      where: { id: orgId },
    });

    if (!currentOrg) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    const currentSettings = (currentOrg.settings as Record<string, unknown>) || {};
    const updatedSettings = settings
      ? JSON.parse(JSON.stringify({ ...currentSettings, ...settings }))
      : JSON.parse(JSON.stringify(currentSettings));

    const organization = await db.organization.update({
      where: { id: orgId },
      data: {
        ...(name && { name }),
        ...(logo !== undefined && { logo }),
        ...(primaryColor !== undefined && { primaryColor }),
        settings: updatedSettings,
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
