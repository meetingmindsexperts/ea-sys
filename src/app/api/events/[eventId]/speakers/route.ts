import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";
import { denyReviewer, isTeamRole, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { getOrgContext } from "@/lib/api-auth";
import { parseDateRangeFilters } from "@/lib/date-range-filter";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
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
  // Demographic / professional classification — Speaker model has the
  // same AttendeeRole column that Attendee has; the admin-create form
  // was silently dropping it. Now accepted in parity with the public
  // register path.
  role: attendeeRoleEnum.optional(),
  email: z.string().email().max(255),
  // Secondary email — parity with the Speaker DB column and with the
  // registration-service field.
  additionalEmail: z.string().email().max(255).optional().or(z.literal("")),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  bio: z.string().max(10000).optional(),
  organization: z.string().max(255).optional(),
  jobTitle: z.string().max(255).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(500).optional().or(z.literal("")),
  // `.nullable()` alongside `.optional()` is intentional — the Add Speaker
  // form initializes `photo: null` (not undefined) when no upload has
  // happened yet. Without this, a fresh form submits `{ photo: null }`
  // and Zod rejects with a generic "Expected string, received null" that
  // doesn't name a field in the UI.
  photo: z.string().max(500).optional().nullable().or(z.literal("")),
  city: z.string().max(255).optional(),
  state: z.string().max(255).optional(),
  zipCode: z.string().max(20).optional(),
  country: z.string().max(255).optional(),
  specialty: z.string().max(255).optional(),
  // Free-text when specialty is 'Others' — parity with Attendee.
  customSpecialty: z.string().max(255).optional(),
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

    // Tenancy sweep: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    // Mixed auth — API-key org, else the session user's org (org-null for a
    // linked SUBMITTER/REGISTRANT reader).
    const tenantOrgId = orgCtx?.organizationId ?? session?.user.organizationId ?? "";
    return await runWithTenant(tenantOrgId, async () => {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");

    // Incremental-sync date filters (shared parser — also on registrations +
    // the MCP list tools). An invalid value 400s, never silently widens.
    const dateRange = parseDateRangeFilters((k) => searchParams.get(k));
    if (!dateRange.ok) {
      apiLogger.warn({ msg: "events/speakers:invalid-date-filter", eventId, param: dateRange.param, value: dateRange.value });
      return NextResponse.json({ error: dateRange.message, code: "INVALID_DATE_FILTER" }, { status: 400 });
    }

    // Fetch event validation and speakers in parallel
    const eventWhere = orgCtx
      ? { id: eventId, organizationId: orgCtx.organizationId }
      : buildEventAccessWhere(session!.user, eventId);

    // An org-null role (SUBMITTER / REVIEWER / REGISTRANT) reaches this list for
    // exactly one reason: the abstract and proposal forms look up the caller's
    // OWN speaker row to bind as the author. The full roster is faculty PII —
    // every speaker's email, phone, bio and abstract titles — so they get their
    // own row and nothing else. A reviewer, who has no speaker row, gets an
    // empty list; the author shown beside an abstract comes from the abstracts
    // payload, not from here.
    const ownSpeakerOnly = !orgCtx && !isTeamRole(session!.user.role);

    const [event, speakers] = await Promise.all([
      db.event.findFirst({
        where: eventWhere,
        select: { id: true },
      }),
      db.speaker.findMany({
        where: {
          eventId,
          ...(ownSpeakerOnly && { userId: session!.user.id }),
          ...(status && { status: status as "INVITED" | "CONFIRMED" | "DECLINED" | "CANCELLED" }),
          ...dateRange.where,
        },
        include: {
          _count: {
            select: {
              sessions: true,
              abstracts: true,
            },
          },
          // Selecting `role` enables the Communications page to filter
          // speakers by SessionRole client-side, keeping the recipient
          // count consistent with the server-side filter applied at
          // bulk-email time.
          sessions: {
            select: { role: true },
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
          // Companion/linked registration — the speakers table shows its
          // Registration # so a speaker's attendee facet is findable from
          // the list (organizer request Aug 4, 2026). serialId is not a
          // credential (unlike qrCode — never select that here).
          sourceRegistration: {
            select: { serialId: true },
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
    });
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
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW });
    if (denied) return denied;

    // Tenancy sweep: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    const orgId = orgGuard.orgId;
    return await runWithTenant(orgId, async () => {
    // Access pre-check BEFORE the service: createSpeaker's internal event
    // lookup is org-scoped only, which is fine for ADMIN/ORGANIZER but would
    // let the WEBINARS role (allowed above) create speakers on a CONFERENCE.
    // buildEventAccessWhere confines it to webinar events.
    const accessibleEvent = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!accessibleEvent) {
      apiLogger.warn({ msg: "speaker-create:event-not-found", eventId, userId: session.user.id, role: session.user.role });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const validated = createSpeakerSchema.safeParse(body);

    if (!validated.success) {
      // Log the field errors so server-side debugging has a trail. The
      // client-side toast shows the same info, but the log lets us
      // diagnose after the fact without asking the user to reproduce.
      const flat = validated.error.flatten();
      apiLogger.warn({
        msg: "speaker-create:zod-validation-failed",
        eventId,
        userId: session.user.id,
        fieldErrors: flat.fieldErrors,
        formErrors: flat.formErrors,
      });
      return NextResponse.json(
        { error: "Invalid input", details: flat },
        { status: 400 }
      );
    }

    const result = await createSpeaker({
      eventId,
      organizationId: orgGuard.orgId,
      userId: session.user.id,
      ...validated.data,
      source: "rest",
      requestIp: getClientIp(req),
    });

    if (!result.ok) {
      const status = HTTP_STATUS_FOR_SPEAKER_ERROR[result.code] ?? 500;
      // M12: business rejections (SPEAKER_ALREADY_EXISTS / EVENT_NOT_FOUND)
      // were returned dark on the REST path — MCP logs via runTool, REST must
      // log at its own boundary. Rejections at warn, UNKNOWN at error.
      const logPayload = {
        msg: "speaker-create:create-rejected",
        eventId,
        userId: session.user.id,
        code: result.code,
        status,
      };
      if (result.code === "UNKNOWN") apiLogger.error(logPayload);
      else apiLogger.warn(logPayload);
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.meta ?? {}) },
        { status },
      );
    }

    return NextResponse.json(result.speaker, { status: 201 });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating speaker" });
    return NextResponse.json(
      { error: "Failed to create speaker" },
      { status: 500 }
    );
  }
}
