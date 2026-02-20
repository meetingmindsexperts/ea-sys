import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getOrgContext } from "@/lib/api-auth";

const createSpeakerSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  bio: z.string().optional(),
  organization: z.string().optional(),
  jobTitle: z.string().optional(),
  website: z.string().url().optional().or(z.literal("")),
  photo: z.string().url().optional().or(z.literal("")),
  city: z.string().optional(),
  country: z.string().optional(),
  specialty: z.string().optional(),
  tags: z.array(z.string()).optional(),
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
    const [{ eventId }, orgCtx] = await Promise.all([params, getOrgContext(req)]);

    if (!orgCtx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");

    // Fetch event validation and speakers in parallel
    const [event, speakers] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: orgCtx.organizationId,
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
    // Parallelize params, auth, and body parsing
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

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
      organization,
      jobTitle,
      website,
      photo,
      city,
      country,
      specialty,
      tags,
      socialLinks,
      status,
    } = validated.data;

    // Parallelize event validation and existing speaker check
    const [event, existingSpeaker] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId!,
        },
        select: { id: true },
      }),
      db.speaker.findFirst({
        where: {
          eventId,
          email,
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

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
        organization: organization || null,
        jobTitle: jobTitle || null,
        website: website || null,
        photo: photo || null,
        city: city || null,
        country: country || null,
        specialty: specialty || null,
        tags: tags || [],
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

    // Log the action (non-blocking for better response time)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "Speaker",
        entityId: speaker.id,
        changes: JSON.parse(JSON.stringify({ speaker })),
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json(speaker, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating speaker" });
    return NextResponse.json(
      { error: "Failed to create speaker" },
      { status: 500 }
    );
  }
}
