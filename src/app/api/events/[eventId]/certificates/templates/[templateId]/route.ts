/**
 * Single template: PATCH (update) + DELETE.
 *
 * PATCH accepts any subset of { name, backgroundPdfUrl, textBoxes,
 * sortOrder } — category is intentionally immutable post-create
 * because changing category between ATTENDANCE ⇄ APPRECIATION would
 * invalidate the eligibility math for any in-flight IssuedCertificate
 * audit row. Delete the template + recreate to change category.
 *
 * DELETE is hard but guarded: rejects with 409 + count when any
 * IssuedCertificate or CertificateIssueRun references the template.
 * The FK is SetNull-on-delete as a safety net (audit rows survive even
 * if a race lets the DELETE through), but the API guard is the policy:
 * issued history stays linked to the design that produced it.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { validateBackgroundPdfUrl } from "@/lib/certificates/pdf-loader";
import { Prisma } from "@prisma/client";

interface RouteParams {
  params: Promise<{ eventId: string; templateId: string }>;
}

const FONT_NAMES = [
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
] as const;

const textBoxSchema = z.object({
  id: z.string().min(1).max(64),
  content: z.string().max(500),
  x: z.number().min(0).max(20000),
  y: z.number().min(0).max(20000),
  width: z.number().min(1).max(20000),
  height: z.number().min(1).max(20000),
  font: z.enum(FONT_NAMES),
  size: z.number().min(4).max(120),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  align: z.enum(["left", "center", "right"]),
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).trim().optional(),
  // Guard against a path-traversal / SSRF value being persisted (B1).
  backgroundPdfUrl: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .refine((v) => v == null || validateBackgroundPdfUrl(v).ok, {
      message: "backgroundPdfUrl must be a /uploads/certificates/ path or an https Supabase URL",
    }),
  textBoxes: z.array(textBoxSchema).max(40).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  // Per-template default cover email — patches independently of the
  // visual fields. Pass null to clear (reverts to system default).
  emailSubject: z.string().min(1).max(200).nullable().optional(),
  emailBody: z.string().min(1).max(10000).nullable().optional(),
  // Role/designation ({{role}}) + static per-template CME hours ({{cmeHours}}).
  role: z.string().max(120).trim().nullable().optional(),
  cmeHours: z.number().min(0).max(999).nullable().optional(),
  // Phase 2 survey-gated auto-issue config.
  autoIssueOnSurvey: z.boolean().optional(),
  autoIssueTag: z.string().max(120).trim().nullable().optional(),
});

export async function PATCH(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  let templateId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    templateId = p.templateId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session);
    if (denied) return denied;

    // Combined lookup binds event to org + template to event in one query.
    const template = await db.certificateTemplate.findFirst({
      where: { id: templateId, event: { organizationId: orgGuard.orgId } },
      select: { id: true, eventId: true },
    });
    if (!template || template.eventId !== eventId) {
      apiLogger.warn({
        msg: "cert-templates:patch-not-found-or-cross-tenant",
        eventId,
        userId: session.user.id,
        templateId,
      });
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "cert-templates:patch-invalid-input",
        eventId,
        templateId,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data: Prisma.CertificateTemplateUpdateInput = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.backgroundPdfUrl !== undefined) {
      data.backgroundPdfUrl = parsed.data.backgroundPdfUrl;
    }
    if (parsed.data.textBoxes !== undefined) {
      data.textBoxes = parsed.data.textBoxes as unknown as Prisma.InputJsonValue;
    }
    if (parsed.data.sortOrder !== undefined) data.sortOrder = parsed.data.sortOrder;
    if (parsed.data.emailSubject !== undefined) data.emailSubject = parsed.data.emailSubject;
    if (parsed.data.emailBody !== undefined) data.emailBody = parsed.data.emailBody;
    if (parsed.data.role !== undefined) data.role = parsed.data.role;
    if (parsed.data.cmeHours !== undefined) data.cmeHours = parsed.data.cmeHours;
    if (parsed.data.autoIssueOnSurvey !== undefined) data.autoIssueOnSurvey = parsed.data.autoIssueOnSurvey;
    if (parsed.data.autoIssueTag !== undefined) data.autoIssueTag = parsed.data.autoIssueTag;

    const updated = await db.certificateTemplate.update({
      where: { id: templateId },
      data,
    });

    apiLogger.info({
      msg: "cert-templates:updated",
      eventId,
      userId: session.user.id,
      templateId,
      fieldsChanged: Object.keys(data),
    });

    return NextResponse.json({ template: updated });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-templates:patch-failed", eventId, templateId });
    return NextResponse.json({ error: "Failed to update template" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  let templateId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    templateId = p.templateId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session);
    if (denied) return denied;

    const template = await db.certificateTemplate.findFirst({
      where: { id: templateId, event: { organizationId: orgGuard.orgId } },
      include: {
        _count: { select: { issuedCertificates: true, issueRuns: true } },
      },
    });
    if (!template || template.eventId !== eventId) {
      apiLogger.warn({
        msg: "cert-templates:delete-not-found-or-cross-tenant",
        eventId,
        userId: session.user.id,
        templateId,
      });
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    if (template._count.issuedCertificates > 0 || template._count.issueRuns > 0) {
      apiLogger.warn({
        msg: "cert-templates:delete-blocked-by-history",
        eventId,
        templateId,
        issuedCount: template._count.issuedCertificates,
        runCount: template._count.issueRuns,
      });
      return NextResponse.json(
        {
          error:
            "Cannot delete a template that has issued certificates or active runs. The audit trail must stay intact. Either keep the template (visible in history) or rename it to mark as retired.",
          code: "TEMPLATE_HAS_HISTORY",
          issuedCount: template._count.issuedCertificates,
          runCount: template._count.issueRuns,
        },
        { status: 409 },
      );
    }

    await db.certificateTemplate.delete({ where: { id: templateId } });

    apiLogger.info({
      msg: "cert-templates:deleted",
      eventId,
      userId: session.user.id,
      templateId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-templates:delete-failed", eventId, templateId });
    return NextResponse.json({ error: "Failed to delete template" }, { status: 500 });
  }
}
