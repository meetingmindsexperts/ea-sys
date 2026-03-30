import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { sendEmail, renderTemplate, renderTemplatePlain, getDefaultTemplate, TEMPLATE_VARIABLES, wrapWithBranding, inlineCss, brandingFrom } from "@/lib/email";

interface RouteParams {
  params: Promise<{ eventId: string; templateId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, templateId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    const existing = await db.emailTemplate.findFirst({
      where: { id: templateId, eventId },
    });

    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
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

    const [template, event] = await Promise.all([
      db.emailTemplate.findFirst({
        where: { id: templateId, eventId },
      }),
      db.event.findFirst({
        where: { id: eventId },
        select: { emailHeaderImage: true, emailFooterHtml: true, emailFromAddress: true, emailFromName: true, name: true },
      }),
    ]);

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const branding = {
      emailHeaderImage: event?.emailHeaderImage,
      emailFooterHtml: event?.emailFooterHtml,
      emailFromAddress: event?.emailFromAddress,
      emailFromName: event?.emailFromName,
      eventName: event?.name,
    };

    const body = await req.json();
    const { action } = body; // "preview" or "test"

    // Build sample variables for preview
    const sampleVars: Record<string, string | number> = {
      firstName: "John",
      lastName: "Doe",
      eventName: "Sample Conference 2026",
      eventDate: "Monday, March 15, 2026",
      eventVenue: "Convention Center, Dubai",
      eventAddress: "123 Main Street",
      ticketType: "VIP Pass",
      registrationId: "ABCD1234",
      organizerName: `${session.user.firstName || "Event"} ${session.user.lastName || "Organizer"}`,
      organizerEmail: session.user.email || "organizer@example.com",
      personalMessage: "We're excited to have you!",
      sessionDetails: "Opening Keynote - Main Hall",
      agreementLink: "#",
      abstractTitle: "Sample Abstract Title",
      newStatus: "ACCEPTED",
      statusHeading: "Abstract Accepted!",
      statusMessage: "Congratulations! Your abstract has been accepted.",
      reviewNotes: "Excellent work. Well-structured and relevant.",
      reviewScore: 9,
      managementLink: "#",
      loginLink: "#",
      daysUntilEvent: 7,
      subject: "Custom Subject",
      message: "This is a custom message body.",
      ctaText: "Click Here",
      ctaLink: "#",
    };

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
