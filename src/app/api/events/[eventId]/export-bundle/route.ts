/**
 * GET /api/events/[eventId]/export-bundle: the whole event as one ZIP of CSVs
 * (Sep 30, 2026). Built by src/lib/event-export/bundle.ts, which calls each
 * area's own export as this same user, so every area keeps its own permission
 * check and audit row; this route adds the bundle-level gate, rate limit and
 * one audit row for the ZIP.
 *
 * Admins and organisers only (`events.export`): the bundle carries
 * attendee PII and money for a whole event, which is wider than any single
 * export a desk role may take.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { recordExport } from "@/lib/audit-data-transfer";
import { resolveShareEvent } from "@/lib/share-link-access";
import { buildEventBundle } from "@/lib/event-export/bundle";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { eventId } = await params;
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "events.export", { route: "events/[eventId]/export-bundle:GET", eventId });
    if (!gate.ok) return gate.response;
    const r = await resolveShareEvent(session, "events/[eventId]/export-bundle:GET", eventId, gate.eventWhere);
    if (r.error) return r.error;

    // A whole-event pull is heavy and sensitive: a small budget per person.
    const limit = checkRateLimit({ key: `event-export-bundle:${eventId}:${session.user.id}`, limit: 5, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      apiLogger.warn({ msg: "event-export:rate-limited", eventId, userId: session.user.id, retryAfterSeconds: limit.retryAfterSeconds });
      return NextResponse.json(
        { error: "You have exported this event several times in the last hour. Please try again later.", retryAfterSeconds: limit.retryAfterSeconds, limit: 5, windowSeconds: 3600 },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }

    return await runWithTenant(r.event.organizationId, async () => {
      const started = Date.now();
      const role = session.user.role ?? "";
      const userName = [session.user.firstName, session.user.lastName].filter(Boolean).join(" ") || session.user.email || session.user.id;
      const bundle = await buildEventBundle({ req, eventId: r.event.id, role, userName });

      recordExport(req, {
        entityType: "EventDataBundle",
        eventId: r.event.id,
        organizationId: r.event.organizationId,
        userId: session.user.id,
        role,
        source: "rest",
        rowCount: bundle.totalRows,
        format: "zip",
        filters: {
          files: bundle.parts.filter((p) => !p.skipped).length,
          skipped: bundle.parts.filter((p) => p.skipped).map((p) => p.label).join("; ") || "none",
        },
      });
      apiLogger.info({
        msg: "event-export:built",
        eventId,
        userId: session.user.id,
        files: bundle.parts.filter((p) => !p.skipped).length,
        skipped: bundle.parts.filter((p) => p.skipped).length,
        rows: bundle.totalRows,
        bytes: bundle.zip.length,
        ms: Date.now() - started,
      });

      return new NextResponse(new Uint8Array(bundle.zip), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${bundle.filename}"`,
          "Cache-Control": "no-store",
        },
      });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "event-export:failed" });
    return NextResponse.json({ error: "The export failed. Please try again." }, { status: 500 });
  }
}
