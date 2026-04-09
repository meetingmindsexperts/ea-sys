import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { slugify } from "@/lib/utils";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { denyReviewer } from "@/lib/auth-guards";
import { validateApiKey } from "@/lib/api-key";
import { DEFAULT_TEMPLATES } from "@/lib/email";
import { DEFAULT_REG_TYPES, DEFAULT_TIER_NAMES } from "@/app/api/events/[eventId]/tickets/route";
import { DEFAULT_REGISTRATION_TERMS_HTML, DEFAULT_SPEAKER_AGREEMENT_HTML } from "@/lib/default-terms";

const createEventSchema = z.object({
  name: z.string().min(2).max(255),
  description: z.string().max(2000).optional(),
  eventType: z.enum(["CONFERENCE", "WEBINAR", "HYBRID"]).optional(),
  tag: z.string().max(255).optional(),
  specialty: z.string().max(255).optional(),
  code: z.string().max(20).optional(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  venue: z.string().max(255).optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(255).optional(),
  country: z.string().max(255).optional(),
});

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const slug = searchParams.get("slug") ?? undefined;

    // Session auth covers all roles (ADMIN, ORGANIZER, REVIEWER, SUBMITTER).
    // REVIEWER and SUBMITTER have organizationId=null, so getOrgContext() would
    // incorrectly return null for them — handle session auth separately here.
    const session = await auth();
    if (session?.user) {
      // SUPER_ADMIN org override via x-org-id header
      const user = { ...session.user };
      if (user.role === "SUPER_ADMIN") {
        const overrideOrgId = req.headers.get("x-org-id");
        if (overrideOrgId) {
          user.organizationId = overrideOrgId;
        }
      }

      const events = await db.event.findMany({
        where: { ...buildEventAccessWhere(user), ...(slug && { slug }) },
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { registrations: true, speakers: true } },
          organization: { select: { name: true } },
        },
      });
      return NextResponse.json(events);
    }

    // No session — check for API key (external tools like n8n)
    const rawKey =
      req.headers.get("x-api-key") ??
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      null;

    if (!rawKey) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await validateApiKey(rawKey);
    if (!result) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const events = await db.event.findMany({
      where: { organizationId: result.organizationId, ...(slug && { slug }) },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { registrations: true, speakers: true } },
      },
    });

    return NextResponse.json(events);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching events" });
    return NextResponse.json(
      { error: "Failed to fetch events" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const body = await req.json();
    const validated = createEventSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { name, description, eventType, tag, specialty, startDate, endDate, venue, address, city, country } =
      validated.data;

    // Create event slug
    let slug = slugify(name);
    const existingEvent = await db.event.findFirst({
      where: {
        organizationId: session.user.organizationId!,
        slug,
      },
    });

    if (existingEvent) {
      slug = `${slug}-${Date.now()}`;
    }

    const event = await db.event.create({
      data: {
        organizationId: session.user.organizationId!,
        name,
        slug,
        description: description || null,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        venue: venue || null,
        address: address || null,
        city: city || null,
        country: country || null,
        eventType: eventType || null,
        tag: tag || null,
        specialty: specialty || null,
        registrationTermsHtml: DEFAULT_REGISTRATION_TERMS_HTML,
        speakerAgreementHtml: DEFAULT_SPEAKER_AGREEMENT_HTML,
      },
    });

    // Seed default email templates for this event (non-blocking)
    db.emailTemplate.createMany({
      data: DEFAULT_TEMPLATES.map((t) => ({
        eventId: event.id,
        slug: t.slug,
        name: t.name,
        subject: t.subject,
        htmlContent: t.htmlContent,
        textContent: t.textContent,
      })),
    }).catch((err) => apiLogger.error({ err, msg: "Failed to seed email templates" }));

    // Seed default registration types with pricing tiers (non-blocking)
    // 5 types × 4 tiers = 20 combinations, all tiers inactive by default
    Promise.all(
      DEFAULT_REG_TYPES.map((rt) =>
        db.ticketType.create({
          data: {
            eventId: event.id,
            name: rt.name,
            isDefault: true,
            isActive: true,
            sortOrder: rt.sortOrder,
            pricingTiers: {
              create: DEFAULT_TIER_NAMES.map((tierName, i) => ({
                name: tierName,
                price: 0,
                currency: "USD",
                isActive: false,
                sortOrder: i,
              })),
            },
          },
        })
      )
    ).catch((err) => apiLogger.error({ err, msg: "Failed to seed default registration types" }));

    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating event" });
    return NextResponse.json(
      { error: "Failed to create event" },
      { status: 500 }
    );
  }
}
