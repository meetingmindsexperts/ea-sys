import crypto from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { format } from "date-fns";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit, hashVerificationToken } from "@/lib/security";
import { sendEmail, emailTemplates } from "@/lib/email";

const bodySchema = z.object({
  registrationIds: z.array(z.string().min(1)).min(1).max(500),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const rateLimit = checkRateLimit({
      key: `send-completion-emails:org:${session.user.organizationId}`,
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Rate limit reached. Maximum 5 bulk sends per hour." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }

    const body = await req.json();
    const validated = bodySchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "Send completion emails validation failed", errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const { registrationIds } = validated.data;

    // Parallelize event access check + registrations lookup
    const [event, registrations] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true, name: true, slug: true, startDate: true, venue: true, city: true, country: true },
      }),
      db.registration.findMany({
        where: { id: { in: registrationIds }, eventId, status: { notIn: ["CANCELLED"] } },
        select: {
          id: true,
          userId: true,
          attendee: { select: { email: true, firstName: true, lastName: true } },
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (registrations.length === 0) {
      apiLogger.warn({ msg: "No valid registrations found for completion emails", eventId, requestedIds: registrationIds.length });
      return NextResponse.json({ error: "No valid (non-cancelled) registrations found for the provided IDs" }, { status: 404 });
    }

    if (registrations.length < registrationIds.length) {
      apiLogger.info({ msg: "Some registration IDs not found or cancelled", eventId, requested: registrationIds.length, found: registrations.length });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const eventDate = format(new Date(event.startDate), "MMM d, yyyy");
    const eventVenue = [event.venue, event.city, event.country].filter(Boolean).join(", ");

    let sent = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const reg of registrations) {
      // Skip registrations that already have a user account linked
      if (reg.userId) {
        skipped++;
        continue;
      }

      try {
        // Delete any existing completion token for this registration (supports resend)
        await db.verificationToken.deleteMany({
          where: { identifier: `reg:${reg.id}` },
        });

        // Generate token
        const rawToken = crypto.randomBytes(32).toString("hex");
        const hashedToken = hashVerificationToken(rawToken);
        const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        // Store token
        await db.verificationToken.create({
          data: {
            identifier: `reg:${reg.id}`,
            token: hashedToken,
            expires,
          },
        });

        // Build completion link
        const completionLink = `${appUrl}/e/${event.slug}/complete-registration?token=${rawToken}`;

        // Send email
        const template = emailTemplates.registrationCompletion({
          recipientName: `${reg.attendee.firstName} ${reg.attendee.lastName}`,
          recipientEmail: reg.attendee.email,
          eventName: event.name,
          eventDate,
          eventVenue,
          completionLink,
          expiresIn: "7 days",
        });

        const emailResult = await sendEmail({
          to: [{ email: reg.attendee.email, name: `${reg.attendee.firstName} ${reg.attendee.lastName}` }],
          subject: template.subject,
          htmlContent: template.htmlContent,
          textContent: template.textContent,
          logContext: {
            organizationId: session.user.organizationId ?? null,
            eventId,
            entityType: "REGISTRATION",
            entityId: reg.id,
            templateSlug: "registration-completion",
            triggeredByUserId: session.user.id,
          },
        });

        if (!emailResult.success) {
          apiLogger.warn({ msg: "Completion email delivery failed", registrationId: reg.id, email: reg.attendee.email, provider: process.env.EMAIL_PROVIDER || "auto", error: emailResult.error });
          errors.push(`${reg.attendee.email}: failed to deliver email — ${emailResult.error || "provider rejected"}`);
          // Clean up the token since email failed
          await db.verificationToken.deleteMany({ where: { identifier: `reg:${reg.id}` } });
        } else {
          sent++;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        apiLogger.error({ msg: "Unexpected error processing completion email", registrationId: reg.id, email: reg.attendee.email, err: errMsg });
        errors.push(`${reg.attendee.email}: ${errMsg}`);
      }
    }

    apiLogger.info({ msg: "Completion emails sent", eventId, userId: session.user.id, sent, skipped, errorCount: errors.length });

    return NextResponse.json({ sent, skipped, errors });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Unhandled error in send-completion-emails endpoint" });
    return NextResponse.json({ error: "An unexpected error occurred while sending completion emails. Please try again." }, { status: 500 });
  }
}
