import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { slugify } from "@/lib/utils";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { validateApiKey } from "@/lib/api-key";

const createEventSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  eventType: z.enum(["CONFERENCE", "WEBINAR", "HYBRID"]).optional(),
  tag: z.string().optional(),
  specialty: z.string().optional(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  venue: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
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
      const events = await db.event.findMany({
        where: { ...buildEventAccessWhere(session.user), ...(slug && { slug }) },
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { registrations: true, speakers: true } },
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

    if (session.user.role === "REVIEWER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const validated = createEventSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { name, description, startDate, endDate, venue, address, city, country } =
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
      },
    });

    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating event" });
    return NextResponse.json(
      { error: "Failed to create event" },
      { status: 500 }
    );
  }
}
