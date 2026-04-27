import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom, brandingCc } from "@/lib/email";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { normalizeEmail, repointOrgContactEmail } from "@/lib/email-change";

const sendEmailSchema = z.object({
  type: z.enum(["confirmation", "reminder", "payment-reminder", "custom"]).default("confirmation"),
  customSubject: z.string().optional(),
  customMessage: z.string().optional(),
  daysUntilEvent: z.number().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, registrationId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const emailLimit = checkRateLimit({
      key: `registration-email:${session.user.id}`,
      limit: 200,
      windowMs: 60 * 60 * 1000,
    });
    if (!emailLimit.allowed) {
      return NextResponse.json(
        { error: "Email rate limit reached. Maximum 200 emails per hour." },
        { status: 429, headers: { "Retry-After": String(emailLimit.retryAfterSeconds) } }
      );
    }

    const [event, registration] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
      }),
      db.registration.findFirst({
        where: { id: registrationId, eventId },
        include: { ticketType: true, attendee: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    let body: unknown = {};
    try {
      body = await req.json();
    } catch (err) {
      apiLogger.warn({ msg: "Failed to parse email request body, defaulting to confirmation", error: err instanceof Error ? err.message : "Unknown" });
    }
    const validated = sendEmailSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { type, customSubject, customMessage, daysUntilEvent } = validated.data;

    const eventDate = event.startDate
      ? new Date(event.startDate).toLocaleDateString("en-US", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
        })
      : "TBA";

    const vars: Record<string, string | number> = {
      firstName: registration.attendee.firstName,
      lastName: registration.attendee.lastName,
      eventName: event.name,
      eventDate,
      eventVenue: event.venue || "TBA",
      eventAddress: event.address || "",
      ticketType: registration.ticketType?.name || "General Admission",
      registrationId: registration.serialId != null
        ? String(registration.serialId).padStart(3, "0")
        : registration.id.slice(-8).toUpperCase(),
    };

    const slugMap: Record<string, string> = {
      confirmation: "registration-confirmation",
      reminder: "event-reminder",
      "payment-reminder": "payment-reminder",
      custom: "custom-notification",
    };

    if (type === "reminder") {
      vars.daysUntilEvent = daysUntilEvent ?? 1;
    }

    if (type === "payment-reminder") {
      const price = Number(registration.ticketType?.price || 0);
      const currency = registration.ticketType?.currency || "USD";
      vars.amount = `${currency} ${price.toFixed(2)}`;

      // Build payment link
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://events.meetingmindsgroup.com";
      const eventSlug = event.slug || event.id;
      const paymentLink = `${appUrl}/e/${eventSlug}/confirmation?id=${registration.id}&name=${encodeURIComponent(String(vars.firstName))}&price=${price}&currency=${currency}`;
      vars.paymentBlock = `<div style="text-align: center; margin: 20px 0;">
        <a href="${paymentLink}" style="display: inline-block; background: #00aade; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 14px;">Pay Now</a>
      </div>`;
    }

    if (type === "custom") {
      if (!customSubject || !customMessage) {
        return NextResponse.json(
          { error: "Custom emails require subject and message" },
          { status: 400 }
        );
      }
      vars.subject = customSubject;
      vars.message = customMessage;
    }

    const tpl = await getEventTemplate(eventId, slugMap[type]) || getDefaultTemplate(slugMap[type]);
    if (!tpl) {
      return NextResponse.json({ error: "Email template not found" }, { status: 500 });
    }

    const branding = tpl && "branding" in tpl ? tpl.branding : { eventName: vars.eventName as string };
    const rendered = renderAndWrap(tpl, vars, branding);

    const attendeeName = `${registration.attendee.firstName} ${registration.attendee.lastName}`;

    const result = await sendEmail({
      to: [{ email: registration.attendee.email, name: attendeeName }],
      cc: brandingCc(branding, [{ email: registration.attendee.email }]),
      ...rendered,
      from: brandingFrom(branding),
      logContext: {
        organizationId: session.user.organizationId ?? null,
        eventId,
        entityType: "REGISTRATION",
        entityId: registration.id,
        templateSlug: `registration-${type}`,
        triggeredByUserId: session.user.id,
      },
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Failed to send email" },
        { status: 500 }
      );
    }

    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "EMAIL_SENT",
        entityType: "Registration",
        entityId: registration.id,
        changes: {
          emailType: type,
          recipient: registration.attendee.email,
          subject: rendered.subject,
          ip: getClientIp(req),
        },
      },
    });

    return NextResponse.json({
      success: true,
      message: `Email sent to ${registration.attendee.email}`,
      messageId: result.messageId,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error sending registration email" });
    return NextResponse.json(
      { error: "Failed to send email" },
      { status: 500 }
    );
  }
}

// PATCH changes the canonical email on the underlying Attendee (and the
// linked User row, if Registration.userId is set). This is the
// dedicated flow that the general-purpose registration PUT route
// rejects — see updateRegistrationSchema comment in ../route.ts. The
// Attendee row is the natural mutation target even though multiple
// registrations could share it; in practice each registration has its
// own Attendee in EA-SYS, and we de-duplicate inside the transaction
// only when a sibling Attendee at the new email already exists.
const changeEmailSchema = z.object({
  newEmail: z.string().email().max(255),
});

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, registrationId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const changeLimit = checkRateLimit({
      key: `email-change:${session.user.id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!changeLimit.allowed) {
      return NextResponse.json(
        { error: "Email change rate limit reached. Maximum 30 per hour." },
        { status: 429, headers: { "Retry-After": String(changeLimit.retryAfterSeconds) } }
      );
    }

    const body = await req.json();
    const parsed = changeEmailSchema.safeParse(body);
    if (!parsed.success) {
        apiLogger.warn({ msg: "events/registrations/email:zod-validation-failed", errors: parsed.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const newEmail = normalizeEmail(parsed.data.newEmail);
    if (!newEmail) {
      return NextResponse.json({ error: "Invalid email address", code: "INVALID_EMAIL" }, { status: 400 });
    }

    const [event, registration] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true, organizationId: true },
      }),
      db.registration.findFirst({
        where: { id: registrationId, eventId },
        select: {
          id: true,
          userId: true,
          attendee: { select: { id: true, email: true } },
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const oldEmail = registration.attendee.email.toLowerCase();
    if (oldEmail === newEmail) {
      return NextResponse.json({ error: "New email is the same as the current email", code: "NO_CHANGE" }, { status: 400 });
    }

    // Collision check for User.email (global unique).
    const userCollision = registration.userId
      ? await db.user.findFirst({
          where: { email: newEmail, id: { not: registration.userId } },
          select: { id: true },
        })
      : null;

    if (userCollision) {
      return NextResponse.json(
        { error: "Another user account already uses that email", code: "USER_EMAIL_TAKEN" },
        { status: 409 }
      );
    }

    const result = await db.$transaction(async (tx) => {
      // If the Attendee row is shared across multiple Registrations
      // (schema allows it — public register's orphan-attendee reuse path
      // can produce this), mutating email in place would silently change
      // it for siblings. Clone the Attendee into a fresh row for this
      // registration and leave the original untouched.
      const siblingCount = await tx.registration.count({
        where: { attendeeId: registration.attendee.id, id: { not: registrationId } },
      });

      let updatedAttendee;
      let attendeeCloned = false;

      if (siblingCount > 0) {
        const snapshot = await tx.attendee.findUnique({
          where: { id: registration.attendee.id },
        });
        if (!snapshot) {
          throw new Error("ATTENDEE_DISAPPEARED");
        }
        const { id: _oldId, createdAt: _c, updatedAt: _u, customFields, ...rest } = snapshot;
        void _oldId;
        void _c;
        void _u;
        const clone = await tx.attendee.create({
          data: {
            ...rest,
            email: newEmail,
            customFields: (customFields ?? {}) as Prisma.InputJsonValue,
          },
        });
        await tx.registration.update({
          where: { id: registrationId },
          data: { attendeeId: clone.id },
        });
        updatedAttendee = clone;
        attendeeCloned = true;
      } else {
        updatedAttendee = await tx.attendee.update({
          where: { id: registration.attendee.id },
          data: { email: newEmail },
        });
      }

      if (registration.userId) {
        await tx.user.update({
          where: { id: registration.userId },
          data: { email: newEmail },
        });
      }

      const contactAction = await repointOrgContactEmail(tx, {
        organizationId: event.organizationId,
        oldEmail,
        newEmail,
      });

      return { updatedAttendee, contactAction, attendeeCloned };
    });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "Registration",
          entityId: registrationId,
          changes: {
            field: "email",
            before: oldEmail,
            after: newEmail,
            attendeeId: result.updatedAttendee.id,
            attendeeCloned: result.attendeeCloned,
            userCascaded: Boolean(registration.userId),
            contactAction: result.contactAction,
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) => apiLogger.warn({ msg: "registration email-change audit log failed", err }));

    apiLogger.info({
      msg: "registration email changed",
      eventId,
      registrationId,
      attendeeCloned: result.attendeeCloned,
      userCascaded: Boolean(registration.userId),
      contactAction: result.contactAction,
    });

    return NextResponse.json({
      attendee: result.updatedAttendee,
      attendeeCloned: result.attendeeCloned,
      userCascaded: Boolean(registration.userId),
      contactAction: result.contactAction,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002") {
      return NextResponse.json(
        { error: "That email was just taken by another record. Try again.", code: "EMAIL_TAKEN" },
        { status: 409 }
      );
    }
    apiLogger.error({ err: error, msg: "Error changing registration email" });
    return NextResponse.json({ error: "Failed to change email" }, { status: 500 });
  }
}
