/**
 * GET /api/events/[eventId]/survey/responses/export
 *
 * Streams all survey responses for the event as CSV. One row per
 * response with submittedAt + identity + one column per question
 * in current config order. Uses the shared toCsv() helper so the
 * RFC 4180 escaping is identical to the in-app preview.
 *
 * No pagination — the page-level UI uses the JSON route; this is
 * the operator's "give me everything" path. Typical events are
 * <2k responses × ~20 columns ≈ <2 MB, which streams fine in a
 * single Response body. If a 50k-row event ever shows up we'll
 * stream via a ReadableStream chunk-by-chunk.
 *
 * Auth: same shape as the JSON route — auth() → denyReviewer →
 * buildEventAccessWhere. MEMBER allowed (read-only).
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { denyReviewer } from "@/lib/auth-guards";
import {
  surveyConfigSchema,
  type SurveyAnswerValue,
} from "@/lib/survey/schema";
import { toCsv } from "@/lib/survey/aggregate";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

function sanitizeFilenameStem(s: string): string {
  // Strip CR/LF (header-injection vector) + chars that break common
  // shells and Windows filesystems. Falls back to "survey" when the
  // event name has nothing safe left.
  const cleaned = s
    .replace(/[\r\n]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || "survey";
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, name: true, surveyConfig: true },
    });

    if (!event) {
      apiLogger.warn({
        msg: "survey-export:event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const configParsed = event.surveyConfig
      ? surveyConfigSchema.safeParse(event.surveyConfig)
      : null;
    if (!configParsed || !configParsed.success) {
      apiLogger.warn({
        msg: "survey-export:no-config",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "No survey is configured for this event." },
        { status: 404 },
      );
    }
    const config = configParsed.data;

    const responses = await db.surveyResponse.findMany({
      where: { eventId },
      orderBy: { submittedAt: "asc" }, // ascending = chronological export
      select: {
        id: true,
        submittedAt: true,
        answers: true,
        registration: {
          select: {
            attendee: {
              select: { firstName: true, lastName: true, email: true },
            },
          },
        },
      },
    });

    const csv = toCsv(
      config,
      responses.map((r) => ({
        responseId: r.id,
        submittedAt: r.submittedAt,
        registrantFirstName: r.registration?.attendee?.firstName ?? null,
        registrantLastName: r.registration?.attendee?.lastName ?? null,
        registrantEmail: r.registration?.attendee?.email ?? null,
        answers: (r.answers ?? {}) as Record<string, SurveyAnswerValue>,
      })),
    );

    const filename = `survey-${sanitizeFilenameStem(event.name)}-${eventId.slice(0, 8)}.csv`;

    apiLogger.info({
      msg: "survey-export:served",
      eventId,
      userId: session.user.id,
      rowCount: responses.length,
    });

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        // No-cache: the response set is mutable, and we'd rather pay the
        // re-query cost than serve a stale snapshot to finance.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    apiLogger.error({ err, msg: "survey-export:unhandled" });
    return NextResponse.json(
      { error: "Failed to export survey responses" },
      { status: 500 },
    );
  }
}
