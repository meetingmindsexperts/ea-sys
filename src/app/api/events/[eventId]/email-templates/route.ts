import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { DEFAULT_TEMPLATES, TEMPLATE_VARIABLES } from "@/lib/email";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const templates = await db.emailTemplate.findMany({
      where: { eventId },
      orderBy: { createdAt: "asc" },
    });

    // Seed missing templates — covers both fresh events and newly added templates
    const existingSlugs = new Set(templates.map((t) => t.slug));
    const missing = DEFAULT_TEMPLATES.filter((t) => !existingSlugs.has(t.slug));

    if (missing.length > 0) {
      await db.emailTemplate.createMany({
        data: missing.map((t) => ({
          eventId,
          slug: t.slug,
          name: t.name,
          subject: t.subject,
          htmlContent: t.htmlContent,
          textContent: t.textContent,
        })),
        skipDuplicates: true,
      });

      // Re-fetch with the newly added templates
      const allTemplates = await db.emailTemplate.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      });

      return NextResponse.json({
        templates: allTemplates,
        variables: TEMPLATE_VARIABLES,
      });
    }

    return NextResponse.json({
      templates,
      variables: TEMPLATE_VARIABLES,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching email templates" });
    return NextResponse.json({ error: "Failed to fetch email templates" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

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

    const body = await req.json();
    const { slug, name, subject, htmlContent, textContent } = body;

    if (!slug || !name || !subject || !htmlContent) {
      return NextResponse.json(
        { error: "slug, name, subject, and htmlContent are required" },
        { status: 400 }
      );
    }

    const existing = await db.emailTemplate.findUnique({
      where: { eventId_slug: { eventId, slug } },
    });

    if (existing) {
      return NextResponse.json({ error: "Template with this slug already exists" }, { status: 409 });
    }

    const template = await db.emailTemplate.create({
      data: { eventId, slug, name, subject, htmlContent, textContent },
    });

    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating email template" });
    return NextResponse.json({ error: "Failed to create email template" }, { status: 500 });
  }
}
