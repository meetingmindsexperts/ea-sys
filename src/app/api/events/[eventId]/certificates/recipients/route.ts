/**
 * GET /api/events/[eventId]/certificates/recipients
 *   ?templateId=   one certificate only
 *   ?format=csv    the same rows as a file (recorded as an export)
 *   ?view=people   one line per PERSON at the event, assigned or not, with a
 *                  cell per certificate: what the Recipients tab shows, so
 *                  assigning, viewing and searching are one place. Everyone
 *                  at the event only for a caller who may read that list
 *                  (registrations.read / speakers.read on the event); with
 *                  certificates.read alone, the people already on a list
 *
 * The certificate recipients report: every person assigned a certificate at
 * this event and where they stand (assigned, survey answered, certificate
 * sent), plus the people who answered the certificate survey and are assigned
 * nothing. Built by src/lib/certificates/recipients-report.ts; this route only
 * guards and shapes it.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { can } from "@/lib/permissions/can";
import { eventFactsOf } from "@/lib/permissions/event-facts";
import { submissionVisibilityFor } from "@/lib/speaker-submission-visibility";
import { apiLogger } from "@/lib/logger";
import { recordExport } from "@/lib/audit-data-transfer";
import { toCsv } from "@/lib/csv-escape";
import { loadCertificatePeople, loadRecipientReport, recipientReportCsv } from "@/lib/certificates/recipients-report";
import { contentDisposition } from "@/lib/download-filename";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/certificates/recipients:GET" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "certificates.read", { route: "events/[eventId]/certificates/recipients:GET", eventId });
    if (!gate.ok) return gate.response;

    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: {
        id: true,
        slug: true,
        timezone: true,
        cmeHours: true,
        // The facts a second key is judged by, for the people view.
        organizationId: true,
        eventType: true,
        staffAssignments: { select: { userId: true } },
      },
    });
    if (!event) {
      apiLogger.warn({ msg: "cert-recipients:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    if (url.searchParams.get("view") === "people") {
      // certificates.read admitted the caller. The event's whole attendee and
      // speaker lists have their own keys, asked here on this event.
      const facts = eventFactsOf({ ...event, staffUserIds: event.staffAssignments.map((a) => a.userId) });
      const holds = (key: "registrations.read" | "speakers.read") => facts !== null && can(gate.principal, key, { event: facts });
      const access = {
        registrations: holds("registrations.read"),
        speakers: holds("speakers.read"),
        submissions: submissionVisibilityFor(gate.principal, event),
      };
      // tenancy: the report reads swept certificate tables, inside the session org.
      const people = await runWithTenant(orgGuard.orgId, () => loadCertificatePeople(event, access));
      return NextResponse.json(people);
    }
    const templateId = url.searchParams.get("templateId") || undefined;
    // tenancy: the report reads swept certificate tables, inside the session org.
    const report = await runWithTenant(orgGuard.orgId, () => loadRecipientReport(event, { templateId }));

    if (url.searchParams.get("format") !== "csv") {
      return NextResponse.json(report);
    }

    const csv = toCsv(recipientReportCsv(report));
    recordExport(req, {
      entityType: "CertificateAssignment",
      eventId: event.id,
      organizationId: orgGuard.orgId,
      userId: session.user.id,
      role: session.user.role,
      source: "rest",
      rowCount: report.rows.length,
      format: "csv",
      filters: templateId ? { templateId } : {},
    });
    apiLogger.info({
      msg: "cert-recipients:exported",
      eventId: event.id,
      userId: session.user.id,
      rowCount: report.rows.length,
      templateId: templateId ?? null,
    });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": contentDisposition(`certificate-recipients-${event.slug}.csv`),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-recipients:failed", eventId });
    return NextResponse.json({ error: "Failed to load the certificate recipients" }, { status: 500 });
  }
}
