import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { readWebinarSettings } from "@/lib/webinar";
import type { Prisma } from "@prisma/client";

type RouteParams = { params: Promise<{ eventId: string }> };

const updateSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["NEW", "ANSWERED", "DISMISSED"]).optional(),
    /** "Show to attendees" in the Q&A tab. */
    isPublic: z.boolean().optional(),
  })
  .refine((v) => v.status !== undefined || v.isPublic !== undefined, {
    message: "Nothing to change",
  });

/**
 * Producer side of the custom-stream question box (Oct 1, 2026): GET lists
 * the anchor session's questions, newest first; PATCH marks one answered,
 * dismissed, or back to new, and shows or hides it in the attendees' Q&A tab
 * (dismissing also hides it). The event lookup is the handler's
 * `gate.eventWhere`: reading needs `webinar.analytics.read`, changing a
 * question `webinar.manage`, like the room toggle.
 */
async function anchorFor(eventWhere: Prisma.EventWhereInput) {
  const event = await db.event.findFirst({
    where: eventWhere,
    select: { id: true, settings: true },
  });
  if (!event) return null;
  return { eventId: event.id, sessionId: readWebinarSettings(event.settings)?.sessionId ?? null };
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/questions:GET" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.analytics.read", { route: "events/[eventId]/webinar/questions:GET", eventId, onMissing: "hide" });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
      const ctx = await anchorFor(gate.eventWhere);
      if (!ctx) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-questions:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      if (!ctx.sessionId) return NextResponse.json({ questions: [] });
      const questions = await db.webinarViewerQuestion.findMany({
        where: { eventId: ctx.eventId, sessionId: ctx.sessionId },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: { id: true, askerName: true, question: true, status: true, isPublic: true, createdAt: true, answeredAt: true },
      });
      return NextResponse.json({ questions });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-questions:list-failed");
    return NextResponse.json({ error: "Failed to load questions" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => ({}))]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/questions:PATCH" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route: "events/[eventId]/webinar/questions:PATCH", eventId });
    if (!gate.ok) return gate.response;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-questions-update:${session.user.id}`,
      limit: 600,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar-questions:rate-limited");
      return NextResponse.json(
        { error: "Too many requests", retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten() }, "webinar-questions:validation-failed");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const ctx = await anchorFor(gate.eventWhere);
      if (!ctx) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-questions:update-event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const { id, status, isPublic } = parsed.data;
      const data: { status?: string; answeredAt?: Date | null; isPublic?: boolean } = {};
      if (status !== undefined) {
        data.status = status;
        data.answeredAt = status === "ANSWERED" ? new Date() : null;
      }
      if (isPublic !== undefined) data.isPublic = isPublic;
      // A dismissed question is never shown to attendees.
      if (status === "DISMISSED") data.isPublic = false;
      // Bound by event so a question id from another event cannot be touched.
      const updated = await db.webinarViewerQuestion.updateMany({
        where: { id, eventId: ctx.eventId },
        data,
      });
      if (updated.count === 0) {
        apiLogger.warn({ eventId, questionId: id }, "webinar-questions:not-found");
        return NextResponse.json({ error: "Question not found" }, { status: 404 });
      }
      apiLogger.info({ eventId, questionId: id, status, isPublic: data.isPublic, userId: session.user.id }, "webinar-questions:updated");
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-questions:update-failed");
    return NextResponse.json({ error: "Failed to update the question" }, { status: 500 });
  }
}
