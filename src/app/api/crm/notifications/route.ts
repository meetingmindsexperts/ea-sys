import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite } from "@/crm/lib/crm-route";
import {
  listCrmNotifications,
  countUnreadCrmNotifications,
  markCrmNotificationsRead,
} from "@/crm/lib/crm-notifications";

/**
 * Notifications are PER-USER, and an API-key caller has no user. Both handlers
 * refuse that case explicitly (rather than returning someone-else's feed or a
 * silently-empty one) — a 400 with a code, warn-logged like every failure path.
 */
function noUserResponse(route: string, organizationId: string): NextResponse {
  apiLogger.warn({ msg: "crm/notifications:no-user-context", route, organizationId });
  return NextResponse.json(
    { error: "Notifications are per-user; API-key callers have no user", code: "NO_USER_CONTEXT" },
    { status: 400 },
  );
}

/**
 * GET /api/crm/notifications — the caller's own feed + unread count.
 *
 * No money redaction needed: notification titles/messages carry no deal values
 * by design (see crm-notifications.ts), so there is nothing to strip.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  if (!ctx.userId) return noUserResponse("GET", ctx.organizationId);

  try {
    const [notifications, unreadCount] = await Promise.all([
      listCrmNotifications({ organizationId: ctx.organizationId, userId: ctx.userId }),
      countUnreadCrmNotifications({ organizationId: ctx.organizationId, userId: ctx.userId }),
    ]);
    return NextResponse.json({ notifications, unreadCount });
  } catch (err) {
    apiLogger.error({
      msg: "crm/notifications:list-failed",
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load notifications" }, { status: 500 });
  }
}

const markReadSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(100).optional(),
    all: z.boolean().optional(),
  })
  .refine((d) => d.all === true || (d.ids?.length ?? 0) > 0, {
    message: "Pass ids: [...] or all: true",
  });

/**
 * PATCH /api/crm/notifications — mark the caller's notifications read.
 *
 * Body: { ids: string[] } for specific rows, or { all: true } for everything.
 * The service scopes the write to the caller's own userId + org, so a foreign
 * id matches nothing — no IDOR by construction.
 */
export async function PATCH(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;
  if (!ctx.userId) return noUserResponse("PATCH", ctx.organizationId);

  const body = await req.json().catch(() => null);
  const parsed = markReadSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/notifications:PATCH", organizationId: ctx.organizationId });
  }

  try {
    const { count } = await markCrmNotificationsRead({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      ids: parsed.data.all ? undefined : parsed.data.ids,
    });
    return NextResponse.json({ updated: count });
  } catch (err) {
    apiLogger.error({
      msg: "crm/notifications:mark-read-failed",
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not update notifications" }, { status: 500 });
  }
}
