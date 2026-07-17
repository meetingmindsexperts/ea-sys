import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { sendEmail, renderTemplate, renderTemplatePlain, getDefaultTemplate, TEMPLATE_VARIABLES, wrapWithBranding, inlineCss, brandingFrom, buildEventPreviewVariables } from "@/lib/email";
import { buildRealPreviewOverrides } from "@/lib/email-preview-data";
import { isCustomTemplateSlug } from "@/lib/email-template-slugs";

interface RouteParams {
  params: Promise<{ eventId: string; templateId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, templateId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Tenant isolation: bind the event to the caller's org BEFORE touching
    // the template — both eventId and templateId come from the URL, so
    // without this any authenticated user could read another org's
    // templates. 404 (not 403) to avoid existence enumeration.
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const template = await db.emailTemplate.findFirst({
      where: { id: templateId, eventId },
    });

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json({
      template,
      variables: TEMPLATE_VARIABLES[template.slug] || [],
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching email template" });
    return NextResponse.json({ error: "Failed to fetch email template" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, templateId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existing = await db.emailTemplate.findFirst({
      where: { id: templateId, eventId },
    });

    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const body = await req.json();
    const { subject, htmlContent, textContent, isActive, name } = body;

    const template = await db.emailTemplate.update({
      where: { id: templateId },
      data: {
        ...(subject !== undefined && { subject }),
        ...(htmlContent !== undefined && { htmlContent }),
        ...(textContent !== undefined && { textContent }),
        ...(isActive !== undefined && { isActive }),
        ...(name !== undefined && { name }),
      },
    });

    return NextResponse.json(template);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating email template" });
    return NextResponse.json({ error: "Failed to update email template" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, templateId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existing = await db.emailTemplate.findFirst({
      where: { id: templateId, eventId },
    });

    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    // Only organizer-created custom templates are deletable. A system default
    // would just be re-seeded on the next list load, so deleting it is a
    // confusing no-op — offer "Reset to Default" in the editor instead.
    if (!isCustomTemplateSlug(existing.slug)) {
      apiLogger.warn({ msg: "email-templates:delete-system-blocked", eventId, templateId, slug: existing.slug });
      return NextResponse.json(
        { error: "System templates can't be deleted — use Reset to restore the default.", code: "SYSTEM_TEMPLATE" },
        { status: 400 }
      );
    }

    await db.emailTemplate.delete({ where: { id: templateId } });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting email template" });
    return NextResponse.json({ error: "Failed to delete email template" }, { status: 500 });
  }
}

// POST for preview and test email
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, templateId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [template, event, previewUser, realOverrides] = await Promise.all([
      db.emailTemplate.findFirst({
        where: { id: templateId, eventId },
      }),
      // Org-scoped: a null event here means the event isn't in the caller's
      // org (or doesn't exist) — POST renders + can email template content,
      // so this must be tenant-isolated like the other handlers.
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: {
          // Full branding set — must match getEventTemplate so a test/preview
          // renders the SAME header image, footer image, and footer HTML a real
          // send does. (emailFooterImage was previously omitted → footer logo
          // never showed in tests.)
          emailHeaderImage: true, emailFooterImage: true, emailFooterHtml: true,
          emailFromAddress: true, emailFromName: true, emailCcAddresses: true,
          // Real event data so preview/test reflects the actual event.
          name: true, startDate: true, endDate: true, venue: true, address: true, city: true,
          timezone: true, supportEmail: true,
          organization: { select: { name: true } },
          ticketTypes: { where: { isActive: true }, select: { name: true }, orderBy: { sortOrder: "asc" }, take: 1 },
          // One real registration so {{registrationId}} shows a real
          // confirmation number (falls back to "9999" if none exist).
          registrations: { select: { id: true, serialId: true }, orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
      // The caller's profile signature so {{organizerSignature}} previews as
      // what a real send from this user would render (their own, or nothing).
      db.user.findUnique({
        where: { id: session.user.id },
        select: { emailSignature: true },
      }),
      // Real session/Zoom/abstract/speaker data so tokens preview as ACTUAL
      // event data, not samples.
      buildRealPreviewOverrides(eventId),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const branding = {
      emailHeaderImage: event?.emailHeaderImage,
      emailFooterImage: event?.emailFooterImage,
      emailFooterHtml: event?.emailFooterHtml,
      emailFromAddress: event?.emailFromAddress,
      emailFromName: event?.emailFromName,
      emailCcAddresses: event?.emailCcAddresses ?? [],
      eventName: event?.name,
    };

    const body = await req.json();
    const { action } = body; // "preview" or "test"

    // Render with REAL event data (name, dates, venue, organizer, ticket type,
    // sessions, abstracts) so the preview/test reflects this event, not samples.
    const sampleVars = buildEventPreviewVariables(
      event,
      { ...session.user, emailSignature: previewUser?.emailSignature ?? null },
      realOverrides,
    );

    const renderedBody = renderTemplate(template.htmlContent, sampleVars);
    const renderedSubject = renderTemplatePlain(template.subject, sampleVars);
    const wrappedHtml = inlineCss(wrapWithBranding(renderedBody, branding));

    if (action === "test") {
      // Send test email to current user
      const user = await db.user.findUnique({
        where: { id: session.user.id },
        select: { email: true, firstName: true },
      });

      if (!user) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }

      const result = await sendEmail({
        to: [{ email: user.email, name: user.firstName || "Test" }],
        subject: `[TEST] ${renderedSubject}`,
        htmlContent: wrappedHtml,
        from: brandingFrom(branding),
        emailType: "template_test",
        stream: "transactional",
      });

      return NextResponse.json({
        success: result.success,
        message: result.success ? `Test email sent to ${user.email}` : result.error,
      });
    }

    // Preview mode — return rendered HTML
    return NextResponse.json({
      subject: renderedSubject,
      htmlContent: wrappedHtml,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error processing email template action" });
    return NextResponse.json({ error: "Failed to process request" }, { status: 500 });
  }
}

// Reset template to default
export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, templateId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existing = await db.emailTemplate.findFirst({
      where: { id: templateId, eventId },
    });

    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const defaultTpl = getDefaultTemplate(existing.slug);
    if (!defaultTpl) {
      return NextResponse.json({ error: "No default template for this slug" }, { status: 404 });
    }

    const template = await db.emailTemplate.update({
      where: { id: templateId },
      data: {
        subject: defaultTpl.subject,
        htmlContent: defaultTpl.htmlContent,
        textContent: defaultTpl.textContent,
        name: defaultTpl.name,
        isActive: true,
      },
    });

    return NextResponse.json(template);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error resetting email template" });
    return NextResponse.json({ error: "Failed to reset email template" }, { status: 500 });
  }
}
