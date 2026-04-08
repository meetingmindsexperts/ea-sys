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
  getSamplePreviewVariables,
} from "@/lib/email";

type RouteParams = { params: Promise<{ eventId: string }> };

const previewSchema = z.object({
  slug: z.string().min(1).max(100),
  customSubject: z.string().max(500).optional(),
  customMessage: z.string().max(10000).optional(),
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

    const { slug, customSubject, customMessage } = parsed.data;

    // Verify event access (org-scoped for team members)
    const event = await db.event.findFirst({
      where: {
        id: eventId,
        ...(session.user.organizationId ? { organizationId: session.user.organizationId } : {}),
      },
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // getEventTemplate loads DB template with fallback to default, plus event branding
    const eventTemplate = await getEventTemplate(eventId, slug);

    if (!eventTemplate) {
      apiLogger.warn({ msg: "Email preview template not found", slug, eventId });
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const sampleVars = getSamplePreviewVariables({
      organizerName: `${session.user.firstName || "Event"} ${session.user.lastName || "Organizer"}`,
      organizerEmail: session.user.email || "organizer@example.com",
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
