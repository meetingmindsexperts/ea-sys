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
import {
  createSpeaker,
  type CreateSpeakerErrorCode,
} from "@/services/speaker-service";

// HTTP status mapping for the service's domain error codes.
const HTTP_STATUS_FOR_SPEAKER_ERROR: Record<CreateSpeakerErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  SPEAKER_ALREADY_EXISTS: 400,
  UNKNOWN: 500,
};

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
          accommodation: {
            select: { id: true },
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

    const result = await createSpeaker({
      eventId,
      organizationId: session.user.organizationId!,
      userId: session.user.id,
      ...validated.data,
      source: "rest",
      requestIp: getClientIp(req),
    });

    if (!result.ok) {
      const status = HTTP_STATUS_FOR_SPEAKER_ERROR[result.code] ?? 500;
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.meta ?? {}) },
        { status },
      );
    }

    return NextResponse.json(result.speaker, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating speaker" });
    return NextResponse.json(
      { error: "Failed to create speaker" },
      { status: 500 }
    );
  }
}
