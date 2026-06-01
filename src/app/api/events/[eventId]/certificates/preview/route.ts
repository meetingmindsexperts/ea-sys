/**
 * GET /api/events/[eventId]/certificates/preview?type=ATTENDANCE|PRESENTER|POSTER|CME
 *
 * Returns a draft PDF of the requested certificate type for the event,
 * using the event's REAL data (name, dates, venue, organization, CME
 * hours, accreditations) and a synthetic recipient ("Dr. Sample
 * Attendee"). No DB writes, no email, no audit log, no serial allocation.
 * The cert's serial reads "PREVIEW-DRAFT-{TYPE}" so it can never be
 * mistaken for an issued cert if printed/shared.
 *
 * Purpose: Phase A of the certificates v1 build — gives the CEO/MD
 * something concrete to react to before we wire up the issuing pipeline.
 *
 * Auth: ADMIN / ORGANIZER / SUPER_ADMIN. denyReviewer also blocks
 * REVIEWER / SUBMITTER / REGISTRANT / MEMBER — MEMBER never sees this
 * route because it's not a finance surface but it IS a write-grade
 * operator action UI-wise.
 *
 * Rate limit: 30/hr per user — same envelope as the speaker-agreement
 * template preview path, generous enough for design iteration.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { apiLogger } from "@/lib/logger";
import { renderCertificate } from "@/lib/certificates/render";
import { buildPreviewCertificate } from "@/lib/certificates/sample-data";
import type { CertificateType } from "@/lib/certificates/types";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const VALID_TYPES: CertificateType[] = ["ATTENDANCE", "PRESENTER", "POSTER", "CME"];

export async function GET(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-preview:no-org", userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(req.url);
    const typeRaw = url.searchParams.get("type");
    if (!typeRaw || !VALID_TYPES.includes(typeRaw as CertificateType)) {
      apiLogger.warn({
        msg: "cert-preview:invalid-type",
        eventId,
        userId: session.user.id,
        typeRaw,
      });
      return NextResponse.json(
        {
          error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
          code: "INVALID_TYPE",
        },
        { status: 400 },
      );
    }
    const type = typeRaw as CertificateType;

    // Per-user rate limit — 30/hr matches speaker-agreement-template upload
    // which is the closest analogous "operator design iteration" surface.
    const rl = checkRateLimit({
      key: `cert-preview:${session.user.id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({
        msg: "cert-preview:rate-limited",
        eventId,
        userId: session.user.id,
        retryAfterSeconds: rl.retryAfterSeconds,
      });
      return NextResponse.json(
        {
          error: "Too many preview requests — back off and try again shortly.",
          code: "RATE_LIMITED",
          retryAfterSeconds: rl.retryAfterSeconds,
          limit: 30,
          windowSeconds: 3600,
        },
        {
          status: 429,
          headers: { "Retry-After": String(rl.retryAfterSeconds) },
        },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        venue: true,
        city: true,
        country: true,
        cmeHours: true,
        settings: true,
        organization: { select: { name: true, logo: true } },
      },
    });
    if (!event) {
      apiLogger.warn({
        msg: "cert-preview:event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const data = buildPreviewCertificate({ type, event });
    const pdf = await renderCertificate(data);

    apiLogger.info({
      msg: "cert-preview:rendered",
      eventId,
      userId: session.user.id,
      type,
      bytes: pdf.byteLength,
      ip: getClientIp(req),
    });

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        // Inline so the dashboard's <iframe> renders it directly. Cache
        // bust on every request — design iteration means stale caches
        // would actively mislead the CEO/MD.
        "Content-Disposition": `inline; filename="preview-${type.toLowerCase()}.pdf"`,
        "Cache-Control": "private, max-age=0, no-store",
        // Override the global X-Frame-Options for THIS response so the
        // dashboard iframe can render it. Same-origin framing only —
        // matches the global default after the 2026-06-01 hardening.
        // Belt-and-suspenders explicit because the cost of getting this
        // wrong is "preview doesn't render, no server-side log
        // explains why" — exactly the failure mode we just fixed.
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": "frame-ancestors 'self'",
      },
    });
  } catch (error) {
    apiLogger.error({
      err: error,
      msg: "cert-preview:render-failed",
      eventId,
    });
    return NextResponse.json(
      { error: "Failed to render certificate preview" },
      { status: 500 },
    );
  }
}
