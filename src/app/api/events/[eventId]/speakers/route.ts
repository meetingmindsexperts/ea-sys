import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";
import { denyReviewer } from "@/lib/auth-guards";
import { getOrgContext } from "@/lib/api-auth";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { titleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";
import { notifyEventAdmins } from "@/lib/notifications";

const createSpeakerSchema = z.object({
  title: titleEnum.optional(),
  email: z.string().email().max(255),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  bio: z.string().max(10000).optional(),
  organization: z.string().max(255).optional(),
  jobTitle: z.string().max(255).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(500).optional().or(z.literal("")),
  photo: z.string().max(500).optional().or(z.literal("")),
  city: z.string().max(255).optional(),
  country: z.string().max(255).optional(),
  specialty: z.string().max(255).optional(),
  registrationType: z.string().max(255).optional(),
  tags: z.array(z.string().max(100).transform(normalizeTag)).optional(),
  socialLinks: z.object({
    twitter: z.string().max(500).optional(),
    linkedin: z.string().max(500).optional(),
    github: z.string().max(500).optional(),
  }).optional(),
  status: z.enum(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]).default("INVITED"),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, orgCtx, session] = await Promise.all([params, getOrgContext(req), auth()]);

    // Support both API key auth (orgCtx) and session auth (for SUBMITTER/REGISTRANT)
    if (!orgCtx && !session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");

    // Fetch event validation and speakers in parallel
    const eventWhere = orgCtx
      ? { id: eventId, organizationId: orgCtx.organizationId }
      : buildEventAccessWhere(session!.user, eventId);

    const [event, speakers] = await Promise.all([
      db.event.findFirst({
        where: eventWhere,
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
      title,
      email,
      firstName,
      lastName,
      bio,
      organization,
      jobTitle,
      phone,
      website,
      photo,
      city,
      country,
      specialty,
      registrationType,
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
        title: title || null,
        email,
        firstName,
        lastName,
        bio: bio || null,
        organization: organization || null,
        jobTitle: jobTitle || null,
        phone: phone || null,
        website: website || null,
        photo: photo || null,
        city: city || null,
        country: country || null,
        specialty: specialty || null,
        registrationType: registrationType || null,
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

    // Sync to org contact store (awaited — errors caught internally)
    await syncToContact({
      organizationId: session.user.organizationId!,
      eventId,
      email,
      firstName,
      lastName,
      title: title || null,
      organization: organization || null,
      jobTitle: jobTitle || null,
      phone: phone || null,
      photo: photo || null,
      city: city || null,
      country: country || null,
      bio: bio || null,
      specialty: specialty || null,
      registrationType: registrationType || null,
    });

    // Log the action (non-blocking for better response time)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "Speaker",
        entityId: speaker.id,
        changes: { ...JSON.parse(JSON.stringify({ speaker })), ip: getClientIp(req) },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    // Notify admins of new speaker
    notifyEventAdmins(eventId, {
      type: "REGISTRATION",
      title: "Speaker Added",
      message: `${firstName} ${lastName} added as speaker`,
      link: `/events/${eventId}/speakers`,
    }).catch((err) => apiLogger.error({ err, msg: "Failed to send speaker notification" }));

    return NextResponse.json(speaker, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating speaker" });
    return NextResponse.json(
      { error: "Failed to create speaker" },
      { status: 500 }
    );
  }
}
