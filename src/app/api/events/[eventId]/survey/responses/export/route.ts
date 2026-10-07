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
 * Auth: `surveys.export` (admins, organizers, the webinar team on webinars).
 * MEMBER reads the answers on screen but does not download them.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { recordExport } from "@/lib/audit-data-transfer";
import { requirePermission } from "@/lib/permissions/require-permission";
import { type SurveyAnswerValue } from "@/lib/survey/schema";
import { parseStoredSurveyConfig, resolveReportSurvey } from "@/services/survey-service";
import { toCsv } from "@/lib/survey/aggregate";
import { isDailyMode, responseDay } from "@/lib/survey/response-mode";

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

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const gate = requirePermission(session, "surveys.export", { route: "events/[eventId]/survey/responses/export:GET", eventId });
    if (!gate.ok) return gate.response;

    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, name: true, surveyConfig: true, surveyIntroHtml: true, surveyThankYouHtml: true, organizationId: true, timezone: true },
    });

    if (!event) {
      apiLogger.warn({
        msg: "survey-export:event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Which survey (Oct 6, 2026): ?surveyId=, else the certificate survey.
    const surveyIdParam = new URL(req.url).searchParams.get("surveyId") ?? undefined;
    if (surveyIdParam !== undefined && (surveyIdParam.length === 0 || surveyIdParam.length > 64)) {
      apiLogger.warn({ msg: "survey-export:invalid-survey-id", eventId });
      return NextResponse.json({ error: "Invalid survey" }, { status: 400 });
    }

    // Tenancy (Domain #16): swept Survey / SurveyResponse (+ nested swept
    // Registration/Attendee) read in the RESOURCE org — gate.eventWhere
    // serves org-null SUPER_ADMIN, so session-org would fail-close for them.
    const loaded = await runWithTenant(event.organizationId, async () => {
      const report = await resolveReportSurvey(event, surveyIdParam);
      if (!report) return { outcome: "not-found" as const };
      const config = parseStoredSurveyConfig(report.rawConfig, { eventId, surveyId: report.survey?.id });
      if (!config) return { outcome: "no-config" as const };
      const responses = await db.surveyResponse.findMany({
        where: report.where,
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
      return { outcome: "ok" as const, report, config, responses };
    });
    if (loaded.outcome === "not-found") {
      apiLogger.warn({ msg: "survey-export:survey-not-found", eventId, surveyId: surveyIdParam });
      return NextResponse.json({ error: "Survey not found" }, { status: 404 });
    }
    if (loaded.outcome === "no-config") {
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
    const { config, responses } = loaded;
    // A once-per-day survey gets a "day" column (Phase 4).
    const daily = isDailyMode(loaded.report.survey?.responseMode);

    const csv = toCsv(
      config,
      responses.map((r) => ({
        responseId: r.id,
        submittedAt: r.submittedAt,
        day: daily ? responseDay(r.submittedAt, event.timezone) : null,
        registrantFirstName: r.registration?.attendee?.firstName ?? null,
        registrantLastName: r.registration?.attendee?.lastName ?? null,
        registrantEmail: r.registration?.attendee?.email ?? null,
        answers: (r.answers ?? {}) as Record<string, SurveyAnswerValue>,
      })),
      { dayColumn: daily },
    );

    // An extra survey's file carries its own name so two downloads never
    // look alike; the certificate survey keeps the old name.
    const stem = loaded.report.survey && !loaded.report.survey.gatesCertificates
      ? `${sanitizeFilenameStem(event.name)}-${sanitizeFilenameStem(loaded.report.survey.name)}`
      : sanitizeFilenameStem(event.name);
    const filename = `survey-${stem}-${eventId.slice(0, 8)}.csv`;

    recordExport(req, {
      entityType: "SurveyResponse",
      eventId,
      organizationId: session.user.organizationId,
      userId: session.user.id,
      role: session.user.role,
      rowCount: responses.length,
      format: "csv",
    });

    apiLogger.info({
      msg: "survey-export:served",
      eventId,
      userId: session.user.id,
      rowCount: responses.length,
      surveyId: loaded.report.survey?.id,
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
