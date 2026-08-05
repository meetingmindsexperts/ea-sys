import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { buildEventAccessWhere } from "@/lib/event-access";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { syncToContact } from "@/lib/contact-sync";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";

type RouteParams = { params: Promise<{ eventId: string }> };

// One select for GET + the PATCH response so the page's shape can't drift.
const MY_PROFILE_SELECT = {
  id: true,
  title: true,
  role: true,
  firstName: true,
  lastName: true,
  email: true,
  additionalEmail: true,
  organization: true,
  jobTitle: true,
  phone: true,
  city: true,
  state: true,
  zipCode: true,
  country: true,
  specialty: true,
  customSpecialty: true,
  bio: true,
  photo: true,
  status: true,
  agreementAcceptedAt: true,
  // The "attendee facet" — the companion (or email-matched) registration
  // that backs this submitter's badge / entry barcode / check-in / survey.
  sourceRegistration: {
    select: {
      id: true,
      serialId: true,
      status: true,
      paymentStatus: true,
      attendanceMode: true,
      badgeType: true,
      qrCode: true,
      checkedInAt: true,
      surveyCompletedAt: true,
      createdSource: true,
      ticketType: { select: { name: true, isFaculty: true } },
    },
  },
  abstracts: {
    select: {
      id: true,
      title: true,
      status: true,
      presentationType: true,
      submittedAt: true,
      reviewedAt: true,
    },
    orderBy: { submittedAt: "desc" as const },
  },
} as const;

// Self-edit fields. Email is deliberately ABSENT (immutable via this route —
// the dedicated change-email flow owns it). `null` clears an optional field;
// `undefined` (absent) leaves it unchanged.
const updateMyProfileSchema = z.object({
  title: titleEnum.nullable().optional(),
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  role: attendeeRoleEnum.nullable().optional(),
  specialty: z.string().max(255).nullable().optional(),
  customSpecialty: z.string().max(255).nullable().optional(),
  organization: z.string().max(255).nullable().optional(),
  jobTitle: z.string().max(255).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  additionalEmail: z
    .union([z.string().trim().email().max(255), z.literal("").transform(() => null)])
    .nullable()
    .optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  zipCode: z.string().max(20).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  bio: z.string().max(5000).nullable().optional(),
  // Relative /uploads path from the shared photo-upload endpoint (not .url()
  // — same reasoning as every other photo schema in the repo).
  photo: z.string().max(500).nullable().optional(),
});

/**
 * GET  /api/events/[eventId]/abstracts/my-profile — self-scoped read for the
 * submitter's My Details page. Resolves the caller's OWN Speaker record on
 * this event (by `Speaker.userId === session user`), so it's ownership-safe
 * by construction.
 *
 * PATCH (Aug 4, 2026 — organizer-reported: profiles minted via the sign-in
 * shortcut are sparse and the person couldn't fix them) — the submitter
 * edits their OWN details: title/name/role/specialty/org/job title/phone/
 * additionalEmail/location. Email stays immutable (house rule — the
 * dedicated change-email flow owns it). Same own-speaker resolution as the
 * GET; audited (source "self") + contact-synced (enrich-only).
 *
 * 404 when the caller has no speaker on this event (not a submitter here).
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Resolve the event FIRST — its org opens the tenant wrap (RESOURCE org, so
    // an org-null SUBMITTER caller works). This also adds an eventId-scoped
    // existence check the handler previously lacked. The speaker read's nested
    // `abstracts` select reads a swept table, so it runs INSIDE the wrap.
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
    const speaker = await db.speaker.findFirst({
      where: { eventId, userId: session.user.id },
      select: MY_PROFILE_SELECT,
    });

    if (!speaker) {
      return NextResponse.json(
        { error: "No submitter profile found for this event", code: "NOT_A_SUBMITTER" },
        { status: 404 }
      );
    }

    return NextResponse.json(speaker);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching submitter profile" });
    return NextResponse.json({ error: "Failed to load your profile" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rl = checkRateLimit({ key: `my-profile-edit:${session.user.id}`, limit: 30, windowMs: 3600_000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "my-profile:rate-limited", userId: session.user.id, eventId });
      return NextResponse.json(
        { error: "Too many updates. Please try again later.", retryAfterSeconds: rl.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const parsed = updateMyProfileSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "my-profile:invalid-input", userId: session.user.id, eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const data = parsed.data;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
      // Ownership by construction: only the caller's OWN speaker resolves.
      const existing = await db.speaker.findFirst({
        where: { eventId, userId: session.user.id },
        select: MY_PROFILE_SELECT,
      });
      if (!existing) {
        apiLogger.warn({ msg: "my-profile:not-a-submitter", userId: session.user.id, eventId });
        return NextResponse.json(
          { error: "No submitter profile found for this event", code: "NOT_A_SUBMITTER" },
          { status: 404 },
        );
      }

      // Name lock (Aug 5, 2026, owner rule): once first/last name is set —
      // which includes anyone with an existing registration, and anyone who
      // saved it once — it can only be CHANGED by the organizing team (like
      // email). Filling a blank name is still allowed.
      const nameChanged = (current: string | null, incoming: string | undefined) =>
        incoming !== undefined && !!current?.trim() && incoming.trim() !== current.trim();
      if (nameChanged(existing.firstName, data.firstName) || nameChanged(existing.lastName, data.lastName)) {
        apiLogger.warn({ msg: "my-profile:name-immutable-block", userId: session.user.id, eventId });
        return NextResponse.json(
          {
            error: "Your name can no longer be changed here — please contact the organizing team.",
            code: "NAME_IMMUTABLE",
          },
          { status: 400 },
        );
      }

      const speaker = await db.speaker.update({
        where: { id: existing.id },
        // `undefined` = leave unchanged, `null` = clear (Prisma semantics).
        data: {
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
          ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
          ...(data.role !== undefined ? { role: data.role } : {}),
          ...(data.specialty !== undefined ? { specialty: data.specialty } : {}),
          ...(data.customSpecialty !== undefined ? { customSpecialty: data.customSpecialty } : {}),
          ...(data.organization !== undefined ? { organization: data.organization } : {}),
          ...(data.jobTitle !== undefined ? { jobTitle: data.jobTitle } : {}),
          ...(data.phone !== undefined ? { phone: data.phone } : {}),
          ...(data.additionalEmail !== undefined ? { additionalEmail: data.additionalEmail } : {}),
          ...(data.city !== undefined ? { city: data.city } : {}),
          ...(data.state !== undefined ? { state: data.state } : {}),
          ...(data.zipCode !== undefined ? { zipCode: data.zipCode } : {}),
          ...(data.country !== undefined ? { country: data.country } : {}),
          ...(data.bio !== undefined ? { bio: data.bio } : {}),
          ...(data.photo !== undefined ? { photo: data.photo } : {}),
        },
        select: MY_PROFILE_SELECT,
      });

      // Self-edit audit — per-field before→after for the touched fields.
      const touched = Object.keys(data) as Array<keyof typeof data>;
      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            organizationId: event.organizationId,
            action: "UPDATE",
            entityType: "Speaker",
            entityId: existing.id,
            changes: {
              source: "self",
              before: Object.fromEntries(touched.map((k) => [k, (existing as Record<string, unknown>)[k] ?? null])),
              after: Object.fromEntries(touched.map((k) => [k, (speaker as Record<string, unknown>)[k] ?? null])),
              fields: touched,
              ip: getClientIp(req),
            },
          },
        })
        .catch((err) => apiLogger.error({ err, msg: "my-profile:audit-failed", speakerId: existing.id }));

      // Keep the org contact store current (enrich-only — never clears).
      await syncToContact({
        organizationId: event.organizationId,
        eventId,
        email: speaker.email,
        additionalEmail: speaker.additionalEmail,
        firstName: speaker.firstName,
        lastName: speaker.lastName,
        title: speaker.title,
        role: speaker.role,
        organization: speaker.organization,
        jobTitle: speaker.jobTitle,
        phone: speaker.phone,
        city: speaker.city,
        state: speaker.state,
        zipCode: speaker.zipCode,
        country: speaker.country,
        specialty: speaker.specialty,
        customSpecialty: speaker.customSpecialty,
        bio: speaker.bio,
        photo: speaker.photo,
      });

      apiLogger.info({ msg: "my-profile:updated", userId: session.user.id, eventId, fields: touched });
      return NextResponse.json(speaker);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating submitter profile" });
    return NextResponse.json({ error: "Failed to update your profile" }, { status: 500 });
  }
}
