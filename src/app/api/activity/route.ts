import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only SUPER_ADMIN and ADMIN can view global activity
    const allowedRoles = ["SUPER_ADMIN", "ADMIN"];
    if (!allowedRoles.includes(session.user.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(req.url);
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit")) || 50, 1),
      100
    );

    // Filters
    const eventId = url.searchParams.get("eventId") || undefined;
    const userId = url.searchParams.get("userId") || undefined;
    const action = url.searchParams.get("action") || undefined;
    const entityType = url.searchParams.get("entityType") || undefined;
    const timeRange = url.searchParams.get("timeRange") || undefined;

    const where: Prisma.AuditLogWhereInput = {
      event: {
        organizationId: session.user.organizationId!,
      },
    };

    if (eventId) {
      where.eventId = eventId;
    }
    if (userId) {
      where.userId = userId;
    }
    if (action) {
      where.action = action;
    }
    if (entityType) {
      where.entityType = entityType;
    }
    if (timeRange) {
      const now = new Date();
      let since: Date | undefined;
      switch (timeRange) {
        case "1h": since = new Date(now.getTime() - 60 * 60 * 1000); break;
        case "24h": since = new Date(now.getTime() - 24 * 60 * 60 * 1000); break;
        case "7d": since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
        case "30d": since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
      }
      if (since) {
        where.createdAt = { gte: since };
      }
    }

    const logs = await db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        changes: true,
        createdAt: true,
        user: {
          select: { firstName: true, lastName: true, email: true },
        },
        event: {
          select: { id: true, name: true },
        },
      },
    });

    return NextResponse.json(logs);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to fetch global activity" });
    return NextResponse.json(
      { error: "Failed to fetch activity" },
      { status: 500 }
    );
  }
}
