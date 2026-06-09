import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import {
  buildShareLinkRecord,
  buildShareUrl,
  readSurveyShareLink,
  surveyExpiryDaysSchema,
} from "@/lib/survey/share-link";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

function resolveAppUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    "http://localhost:3000"
  );
}

const createSchema = z.object({
  expiresInDays: surveyExpiryDaysSchema,
});

// POST — generate or regenerate the event's shareable survey link.
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json().catch(() => ({})),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const rl = checkRateLimit({
      key: `survey-share-link:org:${session.user.organizationId}:event:${eventId}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "survey-share-link:rate-limited", eventId, userId: session.user.id });
      return NextResponse.json(
        { error: "Too many share-link operations. Try again later." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "survey-share-link:validation-failed",
        eventId,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input. expiresInDays must be 3, 5, 7, or 10.", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, slug: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const record = buildShareLinkRecord(parsed.data.expiresInDays, session.user.id);
    await db.event.update({
      where: { id: eventId },
      data: { surveyShareLink: record },
    });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "Event",
          entityId: eventId,
          changes: {
            source: "rest",
            field: "surveyShareLink",
            op: "generated",
            expiresAt: record.expiresAt,
          },
        },
      })
      .catch((err) => apiLogger.error({ err }, "survey-share-link:audit-failed"));

    return NextResponse.json({
      url: buildShareUrl(resolveAppUrl(), event.slug, record.token),
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    });
  } catch (err) {
    apiLogger.error({ err, msg: "survey-share-link:post-unhandled" });
    return NextResponse.json({ error: "Failed to create shareable link" }, { status: 500 });
  }
}

// DELETE — disable the event's shareable survey link.
export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, surveyShareLink: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // No-op if there's nothing to disable (idempotent).
    if (!readSurveyShareLink(event.surveyShareLink)) {
      return NextResponse.json({ ok: true, alreadyDisabled: true });
    }

    await db.event.update({
      where: { id: eventId },
      data: { surveyShareLink: Prisma.JsonNull },
    });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "Event",
          entityId: eventId,
          changes: { source: "rest", field: "surveyShareLink", op: "disabled" },
        },
      })
      .catch((err) => apiLogger.error({ err }, "survey-share-link:audit-failed"));

    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err, msg: "survey-share-link:delete-unhandled" });
    return NextResponse.json({ error: "Failed to disable shareable link" }, { status: 500 });
  }
}
