import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const updateOrganizationSchema = z.object({
  name: z.string().min(1).optional(),
  logo: z.string().url().nullable().optional(),
  settings: z.object({
    timezone: z.string().optional(),
    dateFormat: z.string().optional(),
    currency: z.string().optional(),
    emailNotifications: z.boolean().optional(),
  }).optional(),
});

export async function GET() {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const organization = await db.organization.findUnique({
      where: { id: session.user.organizationId! },
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
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { name, logo, settings } = validated.data;

    // Get current organization to merge settings
    const currentOrg = await db.organization.findUnique({
      where: { id: session.user.organizationId! },
    });

    if (!currentOrg) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    const currentSettings = (currentOrg.settings as Record<string, unknown>) || {};
    const updatedSettings = settings
      ? JSON.parse(JSON.stringify({ ...currentSettings, ...settings }))
      : JSON.parse(JSON.stringify(currentSettings));

    const organization = await db.organization.update({
      where: { id: session.user.organizationId! },
      data: {
        ...(name && { name }),
        ...(logo !== undefined && { logo }),
        settings: updatedSettings,
      },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        action: "UPDATE",
        entityType: "Organization",
        entityId: organization.id,
        changes: validated.data,
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
