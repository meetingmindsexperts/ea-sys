import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { denyReviewer } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import {
  getEventTemplate,
  renderTemplate,
  renderTemplatePlain,
  renderMessageValue,
  wrapWithBranding,
  inlineCss,
  buildEventPreviewVariables,
} from "@/lib/email";
import { buildCertCoverEmailPreview } from "@/lib/certificates/bundle";
import { buildRealPreviewOverrides } from "@/lib/email-preview-data";
import { buildSpeakerEmailContext } from "@/lib/speaker-agreement";
import { getTitleLabel, formatPersonName } from "@/lib/utils";

type RouteParams = { params: Promise<{ eventId: string }> };

const previewSchema = z.object({
  slug: z.string().min(1).max(100),
  customSubject: z.string().max(500).optional(),
  customMessage: z.string().max(10000).optional(),
  // Target speaker — set when previewing from a specific speaker's email
  // dialog (speaker page / detail sheet / reimbursement card). The preview
  // then greets THAT speaker with THEIR presentation context, exactly like
  // the send; without it the preview greets the signed-in operator and shows
  // a representative speaker's blocks (organizer-reported: previewing one
  // speaker's invitation showed a different speaker's name).
  speakerId: z.string().min(1).max(100).optional(),
  // Target registration — same idea for the registration detail sheet's
  // preview: greet the actual registrant with their real Registration #.
  registrationId: z.string().min(1).max(100).optional(),
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

    const { slug, customSubject, customMessage, certificateTemplateIds, speakerId, registrationId } = parsed.data;

    // Verify event access (org-scoped for team members; org-null SUPER_ADMIN
    // passes with no org filter, so the tenant wrap below uses the RESOURCE
    // org, not the session's). Event is unswept → this lookup runs un-wrapped.
    const [eventRow, previewUser] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          ...(session.user.organizationId ? { organizationId: session.user.organizationId } : {}),
        },
        select: {
          id: true, organizationId: true,
          // Real event data so the preview reflects the actual event.
          name: true, startDate: true, endDate: true, venue: true, address: true, city: true,
          timezone: true, supportEmail: true,
          organization: { select: { name: true } },
        },
      }),
      db.user.findUnique({
        where: { id: session.user.id },
        select: { emailSignature: true },
      }),
    ]);

    if (!eventRow) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Tenancy (Certificates-sweep review L1): everything below reads swept
    // tables — CertificateTemplate (cert-cover branch), Speaker/Registration
    // (target overrides + the sample ticket/serial lookups), and
    // buildRealPreviewOverrides' Session/Speaker/Abstract/Registration reads —
    // so the whole body runs in the event's org.
    return await runWithTenant(eventRow.organizationId, async () => {
    // Swept-relation samples + the real-data layer, now inside the wrap (they
    // used to ride the event lookup / the initial Promise.all — under RLS the
    // nested selects fail-closed to [] and the preview silently degraded to
    // canned samples).
    const [eventExtras, realOverrides] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId },
        select: {
          ticketTypes: { where: { isActive: true }, select: { name: true }, orderBy: { sortOrder: "asc" }, take: 1 },
          // One real registration so {{registrationId}} shows a real
          // confirmation number (falls back to "9999" if none exist).
          registrations: { select: { id: true, serialId: true }, orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
      buildRealPreviewOverrides(eventId),
    ]);
    const event = {
      ...eventRow,
      ticketTypes: eventExtras?.ticketTypes ?? [],
      registrations: eventExtras?.registrations ?? [],
    };

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

    // Target-speaker overrides — applied LAST over the sample/representative
    // vars so the preview shows the actual recipient. Mirrors the single-send
    // route's ctx usage (buildSpeakerEmailContext is the shared source), so
    // preview == send by construction.
    let speakerVars: Record<string, string> = {};
    if (speakerId) {
      const speaker = await db.speaker.findFirst({
        where: { id: speakerId, eventId },
        select: { id: true, title: true, firstName: true, lastName: true, email: true },
      });
      if (!speaker) {
        apiLogger.warn({ msg: "email-preview:speaker-not-found", eventId, speakerId });
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }
      const ctx = await buildSpeakerEmailContext(eventId, speakerId);
      speakerVars = {
        firstName: speaker.firstName,
        lastName: speaker.lastName,
        // Same fallbacks as the send route: pre-formatted context values,
        // else format the raw row.
        title: ctx?.title ?? getTitleLabel(speaker.title),
        speakerName: ctx?.speakerName ?? `${speaker.firstName} ${speaker.lastName}`,
        recipientName: ctx?.speakerName ?? `${speaker.firstName} ${speaker.lastName}`,
        presenterName: ctx?.speakerName ?? `${speaker.firstName} ${speaker.lastName}`,
        speakerEmail: speaker.email,
        ...(ctx
          ? {
              jobTitle: ctx.jobTitle,
              speakerOrganization: ctx.speakerOrganization,
              speakerCountry: ctx.speakerCountry,
              sessionTitles: ctx.sessionTitles,
              topicTitles: ctx.topicTitles,
              sessionDateTime: ctx.sessionDateTime,
              trackNames: ctx.trackNames,
              role: ctx.role,
              presentationDetails: ctx.presentationDetails,
              presentationDetailsText: ctx.presentationDetailsText,
              moderatorDetails: ctx.moderatorDetails,
              moderatorDetailsText: ctx.moderatorDetailsText,
            }
          : {}),
      };
    }

    // Target-registration overrides — the registration detail sheet's preview
    // must greet the actual registrant (title-prefixed) with their real
    // Registration #, not the signed-in operator.
    if (registrationId) {
      const registration = await db.registration.findFirst({
        where: { id: registrationId, eventId },
        select: {
          serialId: true,
          attendee: { select: { title: true, firstName: true, lastName: true, email: true } },
          ticketType: { select: { name: true } },
        },
      });
      if (!registration) {
        apiLogger.warn({ msg: "email-preview:registration-not-found", eventId, registrationId });
        return NextResponse.json({ error: "Registration not found" }, { status: 404 });
      }
      const a = registration.attendee;
      const prefixedName = formatPersonName(a.title, a.firstName, a.lastName);
      speakerVars = {
        ...speakerVars,
        title: getTitleLabel(a.title),
        firstName: a.firstName,
        lastName: a.lastName,
        recipientName: prefixedName,
        attendeeName: prefixedName,
        ...(registration.serialId != null
          ? { registrationId: String(registration.serialId).padStart(3, "0") }
          : {}),
        ...(registration.ticketType?.name ? { ticketType: registration.ticketType.name } : {}),
      };
    }

    // getEventTemplate loads DB template with fallback to default, plus event branding
    const eventTemplate = await getEventTemplate(eventId, slug);

    if (!eventTemplate) {
      apiLogger.warn({ msg: "Email preview template not found", slug, eventId });
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const sampleVars = buildEventPreviewVariables(
      event,
      { ...session.user, emailSignature: previewUser?.emailSignature ?? null },
      {
        // Real session/Zoom/abstract/speaker data first; the organizer's
        // typed subject/message must win last.
        ...realOverrides,
        ...(customSubject ? { subject: customSubject } : {}),
        // The typed message must reach BOTH message-shaped tokens — templates
        // like dinner-rsvp-invitation and the speaker templates render
        // {{personalMessage}}, not {{message}}. Before this, the preview showed
        // the canned sample ("We're excited to have you!") instead of what the
        // organizer typed (review R2 M7).
        ...(customMessage ? { message: customMessage, personalMessage: customMessage } : {}),
      },
    );

    // Target speaker (when previewing from a speaker's dialog) wins over the
    // sample/signed-in-user greeting and the representative speaker's blocks.
    const mergedVars: Record<string, string | number> = { ...sampleVars, ...speakerVars };

    // Tokens typed into the compose box must resolve in the PREVIEW exactly
    // like the send (the single-send route's renderMessageValue contract —
    // July 16, 2026): {{personalMessage}} renders the typed message raw,
    // {{message}} escapes its literal text, and substituted raw-key values
    // ({{moderatorDetails}}, {{presentationDetails}}, {{organizerSignature}})
    // stay raw HTML. Before this, a token typed into the message previewed as
    // literal text while the send resolved it — organizer-reported July 29
    // as "moderator block not rendering in preview".
    const previewRawHtmlKeys = new Set([
      "presentationDetails",
      "moderatorDetails",
      "organizerSignature",
      "personalMessage",
      "message",
    ]);
    if (customMessage) {
      mergedVars.personalMessage = renderMessageValue(customMessage, mergedVars, {
        isHtml: true,
        rawHtmlKeys: previewRawHtmlKeys,
      });
      mergedVars.message = renderMessageValue(customMessage, mergedVars, {
        rawHtmlKeys: previewRawHtmlKeys,
      });
    }

    const renderedBody = renderTemplate(eventTemplate.htmlContent, mergedVars, previewRawHtmlKeys);
    // A typed subject previews as the subject — before this it was ignored
    // unless the template's own subject happened to contain {{subject}}
    // (review R2 M7). Tokens typed into it resolve, matching the send.
    const renderedSubject = renderTemplatePlain(
      customSubject || eventTemplate.subject,
      mergedVars,
    );
    const wrappedHtml = inlineCss(wrapWithBranding(renderedBody, eventTemplate.branding));

    return NextResponse.json({ subject: renderedSubject, htmlContent: wrappedHtml });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error previewing email by slug" });
    return NextResponse.json({ error: "Failed to generate preview" }, { status: 500 });
  }
}
