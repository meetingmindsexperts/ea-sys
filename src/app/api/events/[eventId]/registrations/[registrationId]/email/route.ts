import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom } from "@/lib/email";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp, checkRateLimit } from "@/lib/security";

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
