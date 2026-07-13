/**
 * GET /api/events/[eventId]/certificates/preview?templateId={id}
 *
 * Returns a draft PDF of the requested certificate template for the
 * event, using the event's REAL data (name, dates, venue, organization,
 * CME hours, accreditations) and a synthetic recipient ("Dr. Sample
 * Attendee"). No DB writes, no email, no audit log, no serial allocation.
 * The cert's serial reads "PREVIEW-DRAFT-{TYPE}" so it can never be
 * mistaken for an issued cert if printed/shared.
 *
 * v3 multi-template (2026-06-02): templateId binds the preview to a
 * specific template row. Category is derived from the template.
 *
 * Auth: ADMIN / ORGANIZER / SUPER_ADMIN. denyReviewer also blocks
 * REVIEWER / SUBMITTER / REGISTRANT / MEMBER.
 *
 * Rate limit: 30/hr per user — design iteration is the use case.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { apiLogger } from "@/lib/logger";
import { renderCertificate } from "@/lib/certificates/render";
import { buildPreviewCertificate } from "@/lib/certificates/sample-data";
import type { CertificateTemplate } from "@/lib/certificates/types";

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
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-preview:no-org", userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(req.url);
    const templateId = url.searchParams.get("templateId");
    if (!templateId) {
      apiLogger.warn({
        msg: "cert-preview:missing-template-id",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "templateId query parameter is required", code: "MISSING_TEMPLATE_ID" },
        { status: 400 },
      );
    }

    // Per-user rate limit — 30/hr matches speaker-agreement-template upload.
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

    // Combined org-bound lookup — template must live in an event in the
    // user's org, AND the URL eventId must match (defense against id
    // mismatch). 404 on either fail to avoid existence enumeration.
    const template = await db.certificateTemplate.findFirst({
      where: {
        id: templateId,
        event: { organizationId: session.user.organizationId },
      },
      select: {
        id: true,
        eventId: true,
        category: true,
        name: true,
        backgroundPdfUrl: true,
        textBoxes: true,
        event: {
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
        },
      },
    });
    if (!template || template.eventId !== eventId) {
      apiLogger.warn({
        msg: "cert-preview:template-not-found",
        eventId,
        userId: session.user.id,
        templateId,
      });
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const previewTemplate: CertificateTemplate = {
      backgroundPdfUrl: template.backgroundPdfUrl,
      // Prisma's JsonValue can't structurally narrow to CertificateTextBox[]
      // — the column was Zod-validated at write time, so we cast via unknown.
      textBoxes: template.textBoxes as unknown as CertificateTemplate["textBoxes"],
    };

    const data = buildPreviewCertificate({
      type: template.category,
      event: template.event,
      template: previewTemplate,
    });
    // Preview is the ONLY caller allowed to render the "upload a background
    // PDF" placeholder — here it's the intended affordance during editor
    // setup, not a real certificate (see renderCertificate H2 note).
    const pdf = await renderCertificate(data, { allowPlaceholder: true });

    apiLogger.info({
      msg: "cert-preview:rendered",
      eventId,
      userId: session.user.id,
      templateId: template.id,
      templateName: template.name,
      category: template.category,
      bytes: pdf.byteLength,
      ip: getClientIp(req),
    });

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="preview-${template.category.toLowerCase()}-${template.id}.pdf"`,
        "Cache-Control": "private, max-age=0, no-store",
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
