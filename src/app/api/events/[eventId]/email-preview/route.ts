import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { denyReviewer } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  getEventTemplate,
  renderTemplate,
  renderTemplatePlain,
  wrapWithBranding,
  inlineCss,
  buildEventPreviewVariables,
} from "@/lib/email";
import { buildCertCoverEmailPreview } from "@/lib/certificates/bundle";

type RouteParams = { params: Promise<{ eventId: string }> };

const previewSchema = z.object({
  slug: z.string().min(1).max(100),
  customSubject: z.string().max(500).optional(),
  customMessage: z.string().max(10000).optional(),
  // slug === "certificate" only — the CertificateTemplate ids the send
  // would carry. The cert cover email isn't an EmailTemplate slug (it
  // lives on the template row / system defaults), so it renders through
  // buildCertCoverEmailPreview instead of the template pipeline below.
  certificateTemplateIds: z.array(z.string().min(1).max(100)).min(1).max(5).optional(),
});

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const body = await req.json();
    const parsed = previewSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "Email preview validation failed", errors: parsed.error.flatten(), eventId });
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const { slug, customSubject, customMessage, certificateTemplateIds } = parsed.data;

    // Verify event access (org-scoped for team members)
    const event = await db.event.findFirst({
      where: {
        id: eventId,
        ...(session.user.organizationId ? { organizationId: session.user.organizationId } : {}),
      },
      select: {
        id: true,
        // Real event data so the preview reflects the actual event.
        name: true, startDate: true, endDate: true, venue: true, address: true, city: true,
        timezone: true, supportEmail: true,
        organization: { select: { name: true } },
        ticketTypes: { where: { isActive: true }, select: { name: true }, orderBy: { sortOrder: "asc" }, take: 1 },
        // One real registration so {{registrationId}} shows a real
        // confirmation number (falls back to "9999" if none exist).
        registrations: { select: { id: true, serialId: true }, orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Certificate cover-email preview — renders through the cert bundle
    // pipeline (per-template saved cover → system defaults, cert tokens,
    // event branding), not the EmailTemplate pipeline below.
    if (slug === "certificate") {
      if (!certificateTemplateIds?.length) {
        apiLogger.warn({ msg: "Email preview: certificate slug without template ids", eventId });
        return NextResponse.json(
          { error: "Select at least one certificate template to preview", code: "MISSING_CERT_TEMPLATES" },
          { status: 400 },
        );
      }
      const certTemplates = await db.certificateTemplate.findMany({
        where: { id: { in: certificateTemplateIds }, eventId },
        select: { id: true, name: true, category: true, emailSubject: true, emailBody: true },
      });
      if (certTemplates.length !== new Set(certificateTemplateIds).size) {
        apiLogger.warn({
          msg: "Email preview: certificate template not found",
          eventId,
          requested: certificateTemplateIds,
          found: certTemplates.length,
        });
        return NextResponse.json({ error: "Certificate template not found" }, { status: 404 });
      }
      // Preserve the caller's selection order — the FIRST selected template
      // drives the single-template cover-email precedence, same as the send.
      const ordered = certificateTemplateIds
        .map((id) => certTemplates.find((t) => t.id === id))
        .filter((t): t is (typeof certTemplates)[number] => Boolean(t));
      const preview = await buildCertCoverEmailPreview({
        eventId,
        templates: ordered,
        customSubject,
        customMessage,
      });
      if (!preview) {
        apiLogger.error({ msg: "Email preview: cert cover render failed", eventId });
        return NextResponse.json({ error: "Failed to generate preview" }, { status: 500 });
      }
      return NextResponse.json(preview);
    }

    // getEventTemplate loads DB template with fallback to default, plus event branding
    const eventTemplate = await getEventTemplate(eventId, slug);

    if (!eventTemplate) {
      apiLogger.warn({ msg: "Email preview template not found", slug, eventId });
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const sampleVars = buildEventPreviewVariables(event, session.user, {
      ...(customSubject ? { subject: customSubject } : {}),
      ...(customMessage ? { message: customMessage } : {}),
    });

    const renderedBody = renderTemplate(eventTemplate.htmlContent, sampleVars);
    const renderedSubject = renderTemplatePlain(eventTemplate.subject, sampleVars);
    const wrappedHtml = inlineCss(wrapWithBranding(renderedBody, eventTemplate.branding));

    return NextResponse.json({ subject: renderedSubject, htmlContent: wrappedHtml });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error previewing email by slug" });
    return NextResponse.json({ error: "Failed to generate preview" }, { status: 500 });
  }
}
