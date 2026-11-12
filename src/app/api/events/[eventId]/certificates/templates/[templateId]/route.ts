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
import { cmeHoursField } from "@/lib/certificates/cme-hours";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { apiLogger } from "@/lib/logger";
import { setTemplateAutoIssue } from "@/services/certificate-assignment-service";
import { mayReleaseCertificates } from "@/lib/certificates/release-permission";
import { validateBackgroundPdfUrl } from "@/lib/certificates/pdf-loader";
import { certificateTextBoxesSchema } from "@/lib/certificates/template-box-schema";
import { Prisma } from "@prisma/client";

interface RouteParams {
  params: Promise<{ eventId: string; templateId: string }>;
}

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
  textBoxes: certificateTextBoxesSchema.optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  // No per-template cover email since Sep 18, 2026 (the event's Certificate
  // Delivery email template is the wording); a client still sending
  // emailSubject / emailBody has them stripped by Zod, never written.
  // Role/designation ({{role}}) + static per-template CME hours ({{cmeHours}}).
  role: z.string().max(120).trim().nullable().optional(),
  cmeHours: cmeHoursField.nullable().optional(),
  // Survey-gated auto-issue. Turning it ON can send certificates at once (to
  // everyone assigned who has already answered), so it goes through
  // setTemplateAutoIssue, which refuses with CONFIRM_SEND_NOW until the
  // caller passes back the count it was shown as confirmSendNow, and with
  // SEND_NOW_NOT_PERMITTED without certificates.issue. (A retired
  // autoIssueTag is stripped by Zod.)
  autoIssueOnSurvey: z.boolean().optional(),
  confirmSendNow: z.number().int().min(0).max(1_000_000).optional(),
});

const SWITCH_STATUS = { TEMPLATE_NOT_FOUND: 404, CONFIRM_SEND_NOW: 409, SEND_NOW_NOT_PERMITTED: 403 } as const;

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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/certificates/templates/[templateId]:PATCH" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "certificates.templates.manage", { route: "events/[eventId]/certificates/templates/[templateId]:PATCH", eventId: eventId });
    if (!gate.ok) return gate.response;

    // Combined lookup binds event to org + template to event in one query.
    // tenancy: swept CertificateTemplate read runs inside the session org.
    const template = await runWithTenant(orgGuard.orgId, () =>
      db.certificateTemplate.findFirst({
        where: { id: templateId, event: gate.eventWhere },
        select: { id: true, eventId: true },
      }),
    );
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

    // The auto-issue switch first: if it is refused, nothing else in this
    // request is applied either.
    if (parsed.data.autoIssueOnSurvey !== undefined) {
      const enabled = parsed.data.autoIssueOnSurvey;
      const lockedEventId = eventId;
      const lockedTemplateId = template.id;
      const mayReleaseNow = enabled && (await mayReleaseCertificates(gate.principal, lockedEventId, orgGuard.orgId));
      const switched = await runWithTenant(orgGuard.orgId, () =>
        setTemplateAutoIssue({
          eventId: lockedEventId,
          templateId: lockedTemplateId,
          enabled,
          userId: session.user.id,
          source: "rest",
          confirmedSendNow: parsed.data.confirmSendNow,
          mayReleaseNow,
        }),
      );
      if (!switched.ok) {
        // Logged with its code by the service.
        return NextResponse.json(
          { error: switched.message, code: switched.code, ...(switched.meta ?? {}) },
          { status: SWITCH_STATUS[switched.code] },
        );
      }
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
    if (parsed.data.role !== undefined) data.role = parsed.data.role;
    if (parsed.data.cmeHours !== undefined) data.cmeHours = parsed.data.cmeHours;

    // tenancy: swept CertificateTemplate write runs inside the session org.
    const updated = await runWithTenant(orgGuard.orgId, () =>
      db.certificateTemplate.update({
        where: { id: templateId },
        data,
      }),
    );

    apiLogger.info({
      msg: "cert-templates:updated",
      eventId,
      userId: session.user.id,
      templateId,
      fieldsChanged: [
        ...Object.keys(data),
        ...(parsed.data.autoIssueOnSurvey !== undefined ? ["autoIssueOnSurvey"] : []),
      ],
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/certificates/templates/[templateId]:DELETE" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "certificates.templates.manage", { route: "events/[eventId]/certificates/templates/[templateId]:DELETE", eventId: eventId });
    if (!gate.ok) return gate.response;

    // tenancy: swept CertificateTemplate read runs inside the session org.
    const template = await runWithTenant(orgGuard.orgId, () =>
      db.certificateTemplate.findFirst({
        where: { id: templateId, event: gate.eventWhere },
        include: {
          _count: { select: { issuedCertificates: true, issueRuns: true } },
        },
      }),
    );
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

    // tenancy: swept CertificateTemplate delete runs inside the session org.
    // Compound-where (review L3, defence #1 — the MediaFile/BillingAccount
    // pattern): the org bind is atomic with the delete itself, not just the
    // findFirst above, so a raced/mis-scoped id P2025s instead of deleting.
    await runWithTenant(orgGuard.orgId, () =>
      db.certificateTemplate.delete({ where: { id: templateId, organizationId: orgGuard.orgId } }),
    );

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
