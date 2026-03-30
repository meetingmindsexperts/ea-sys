import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

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

    const logs = await db.auditLog.findMany({
      where: {
        event: {
          organizationId: session.user.organizationId!,
        },
      },
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
