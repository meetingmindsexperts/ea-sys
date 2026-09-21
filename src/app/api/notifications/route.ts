import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";

/**
 * Mark-as-read body (Sep 21, 2026 security review, finding #7).
 *
 * Was `body as { ids?: string[] }` — an assertion, so a hostile array reached
 * `id: { in: ... }` untyped and 500'd instead of 400'ing. As with badges the
 * authorisation was already right: the `where` pins `userId` to the session,
 * so an id belonging to someone else's notification simply matches nothing.
 * The cap bounds the `IN` clause; nobody has 1000 unread notifications to mark
 * individually, and "mark everything" is what `all: true` is for.
 */
const markReadSchema = z.object({
  ids: z.array(z.string()).max(1000).optional(),
  all: z.boolean().optional(),
});

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const unreadOnly = searchParams.get("unreadOnly") === "true";

    const where = {
      userId: session.user.id,
      ...(unreadOnly ? { isRead: false } : {}),
    };

    const [notifications, unreadCount] = await Promise.all([
      db.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          type: true,
          title: true,
          message: true,
          link: true,
          isRead: true,
          createdAt: true,
          eventId: true,
        },
      }),
      db.notification.count({
        where: { userId: session.user.id, isRead: false },
      }),
    ]);

    return NextResponse.json({ notifications, unreadCount });
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to fetch notifications" });
    return NextResponse.json(
      { error: "Failed to fetch notifications" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const raw = await req.json().catch(() => null);
    if (raw === null) {
      apiLogger.warn({ msg: "notifications:invalid-json", userId: session.user.id });
      return NextResponse.json({ error: "Invalid JSON body", code: "INVALID_JSON" }, { status: 400 });
    }
    const parsed = markReadSchema.safeParse(raw);
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route: "notifications:PUT", userId: session.user.id });
    }
    const { ids, all } = parsed.data;

    if (all) {
      await db.notification.updateMany({
        where: { userId: session.user.id, isRead: false },
        data: { isRead: true },
      });
      // `Array.isArray` was here before the parse existed; the schema now
      // guarantees the shape, so only emptiness is left to decide.
    } else if (ids && ids.length > 0) {
      await db.notification.updateMany({
        where: {
          id: { in: ids },
          userId: session.user.id,
        },
        data: { isRead: true },
      });
    } else {
      return NextResponse.json(
        { error: "Provide 'ids' array or 'all: true'" },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to mark notifications read" });
    return NextResponse.json(
      { error: "Failed to update notifications" },
      { status: 500 }
    );
  }
}
