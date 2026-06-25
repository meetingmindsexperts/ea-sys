/**
 * GET /api/events/[eventId]/certificates/auto-issue/analytics
 *
 * Survey-gated auto-issue (Phase 2) observability for the certificates
 * page. Aggregates the retry/backoff state of survey-completed
 * registrations + the delivery state of the auto runs they spawned, so
 * an organizer can answer "is auto-issue working / what's stuck?".
 *
 * Registration state (derived from the certAutoIssue* columns):
 *   pending   — surveyed, not yet swept (attempts 0, no terminal stamp)
 *   retrying  — transient failure, backing off (attempts > 0, no stamp)
 *   resolved  — terminally checked, no error
 *   gaveUp    — terminally checked after exhausting retries (error kept)
 *
 * Plus auto-run delivery counts by status, total certs auto-issued, the
 * configured-templates summary (incl. a misconfig flag for auto-issue-on
 * templates with no tag), and the most recent errors for triage.
 *
 * Auth: ADMIN / ORGANIZER (denyReviewer). Event org-bound (404 cross-tenant).
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, cmeHours: true, settings: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "cert-auto-issue-analytics:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // CME status — derived (no separate boolean): an event "has CME" when
    // it has CME hours and/or accrediting bodies. Drives a visible badge so
    // organizers can tell at a glance whether the event is CME-accredited
    // (the {{cmeHours}}/accreditation tokens only render when this is true).
    const settings =
      event.settings && typeof event.settings === "object" && !Array.isArray(event.settings)
        ? (event.settings as Record<string, unknown>)
        : {};
    const cmeBlock =
      settings.cme && typeof settings.cme === "object" && !Array.isArray(settings.cme)
        ? (settings.cme as Record<string, unknown>)
        : {};
    const accreditations = Array.isArray(cmeBlock.accreditations)
      ? (cmeBlock.accreditations as Array<Record<string, unknown>>)
      : [];
    const cmeHours = event.cmeHours == null ? null : Number(event.cmeHours);
    const bodies = accreditations
      .map((a) => (typeof a.body === "string" ? a.body : null))
      .filter((b): b is string => Boolean(b));
    const cme = {
      accredited: cmeHours != null || bodies.length > 0,
      hours: cmeHours,
      bodies,
    };

    const surveyed: Prisma.RegistrationWhereInput = { eventId, surveyCompletedAt: { not: null } };

    const [
      pending,
      retrying,
      resolvedOk,
      gaveUp,
      certsAutoIssued,
      autoRunsByStatus,
      templates,
      recentErrorsRaw,
    ] = await Promise.all([
      db.registration.count({
        where: { ...surveyed, certAutoIssueCheckedAt: null, certAutoIssueAttempts: 0 },
      }),
      db.registration.count({
        where: { ...surveyed, certAutoIssueCheckedAt: null, certAutoIssueAttempts: { gt: 0 } },
      }),
      db.registration.count({
        where: { ...surveyed, certAutoIssueCheckedAt: { not: null }, certAutoIssueError: null },
      }),
      db.registration.count({
        where: { ...surveyed, certAutoIssueCheckedAt: { not: null }, certAutoIssueError: { not: null } },
      }),
      db.issuedCertificate.count({
        where: { eventId, issueRunItem: { run: { autoIssue: true } } },
      }),
      db.certificateIssueRun.groupBy({
        by: ["status"],
        where: { eventId, autoIssue: true },
        _count: { _all: true },
      }),
      db.certificateTemplate.findMany({
        where: { eventId, autoIssueOnSurvey: true },
        select: { id: true, name: true, category: true, autoIssueTag: true },
      }),
      db.registration.findMany({
        where: { ...surveyed, certAutoIssueError: { not: null } },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: {
          id: true,
          certAutoIssueAttempts: true,
          certAutoIssueCheckedAt: true,
          certAutoIssueError: true,
          attendee: { select: { firstName: true, lastName: true, email: true } },
        },
      }),
    ]);

    const runStatusCounts: Record<string, number> = {};
    for (const row of autoRunsByStatus) {
      runStatusCounts[row.status] = row._count._all;
    }

    const templatesMissingTag = templates.filter((t) => !t.autoIssueTag?.trim());

    const recentErrors = recentErrorsRaw.map((r) => ({
      registrationId: r.id,
      name: `${r.attendee?.firstName ?? ""} ${r.attendee?.lastName ?? ""}`.trim() || "(unnamed)",
      email: r.attendee?.email ?? null,
      attempts: r.certAutoIssueAttempts,
      gaveUp: r.certAutoIssueCheckedAt !== null,
      error: r.certAutoIssueError,
    }));

    return NextResponse.json({
      cme,
      registrations: {
        pending,
        retrying,
        resolved: resolvedOk,
        gaveUp,
        total: pending + retrying + resolvedOk + gaveUp,
      },
      certsAutoIssued,
      autoRuns: {
        byStatus: runStatusCounts,
        inFlight:
          (runStatusCounts.PENDING ?? 0) +
          (runStatusCounts.RENDERING ?? 0) +
          (runStatusCounts.SENDING ?? 0),
        completed: runStatusCounts.COMPLETED ?? 0,
        failed: runStatusCounts.FAILED ?? 0,
      },
      templates: {
        configured: templates.length,
        missingTag: templatesMissingTag.length,
        missingTagNames: templatesMissingTag.map((t) => t.name),
      },
      recentErrors,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-auto-issue-analytics:failed", eventId });
    return NextResponse.json({ error: "Failed to load auto-issue analytics" }, { status: 500 });
  }
}
