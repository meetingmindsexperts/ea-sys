import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const createSpeakerSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  bio: z.string().optional(),
  company: z.string().optional(),
  jobTitle: z.string().optional(),
  website: z.string().url().optional().or(z.literal("")),
  headshot: z.string().url().optional().or(z.literal("")),
  socialLinks: z.object({
    twitter: z.string().optional(),
    linkedin: z.string().optional(),
    github: z.string().optional(),
  }).optional(),
  status: z.enum(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]).default("INVITED"),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    // Fetch params and auth in parallel
    const [{ eventId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");

    // Fetch event validation and speakers in parallel
    const [event, speakers] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId,
        },
        select: { id: true },
      }),
      db.speaker.findMany({
        where: {
          eventId,
          ...(status && { status: status as "INVITED" | "CONFIRMED" | "DECLINED" | "CANCELLED" }),
        },
        include: {
          _count: {
            select: {
              sessions: true,
              abstracts: true,
            },
          },
          abstracts: {
            select: {
              id: true,
              title: true,
              status: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const response = NextResponse.json(speakers);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching speakers" });
    return NextResponse.json(
      { error: "Failed to fetch speakers" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { eventId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = createSpeakerSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const {
      email,
      firstName,
      lastName,
      bio,
      company,
      jobTitle,
      website,
      headshot,
      socialLinks,
      status,
    } = validated.data;

    // Check if speaker already exists for this event
    const existingSpeaker = await db.speaker.findFirst({
      where: {
        eventId,
        email,
      },
    });

    if (existingSpeaker) {
      return NextResponse.json(
        { error: "Speaker with this email already exists for this event" },
        { status: 400 }
      );
    }

    const speaker = await db.speaker.create({
      data: {
        eventId,
        email,
        firstName,
        lastName,
        bio: bio || null,
        company: company || null,
        jobTitle: jobTitle || null,
        website: website || null,
        headshot: headshot || null,
        socialLinks: socialLinks || {},
        status,
      },
      include: {
        _count: {
          select: {
            sessions: true,
            abstracts: true,
          },
        },
      },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "Speaker",
        entityId: speaker.id,
        changes: { speaker },
      },
    });

    return NextResponse.json(speaker, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating speaker" });
    return NextResponse.json(
      { error: "Failed to create speaker" },
      { status: 500 }
    );
  }
}
