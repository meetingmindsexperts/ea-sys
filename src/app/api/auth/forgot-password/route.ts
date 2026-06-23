import crypto from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { emailTemplates, sendEmail } from "@/lib/email";
import { checkRateLimit, getClientIp, hashVerificationToken } from "@/lib/security";

const forgotPasswordSchema = z.object({
  email: z.string().email("Please provide a valid email address").max(255),
  /**
   * Optional event slug. When the request came from the event-scoped
   * forgot-password page (/e/[slug]/forgot-password), the reset email
   * link is built with the event-scoped reset path so the user stays
   * in event context end-to-end. Validated against a strict slug
   * regex (letters / numbers / hyphens, max 64 chars) before being
   * interpolated into the email — defense against an attacker
   * shaping the reset URL via a crafted slug.
   */
  eventSlug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/i, "Invalid event slug")
    .optional(),
});

function getPasswordResetIdentifier(email: string) {
  return `password-reset:${email.toLowerCase()}`;
}

export async function POST(req: Request) {
  try {
    const clientIp = getClientIp(req);
    const ipRateLimit = checkRateLimit({
      key: `forgot-password:ip:${clientIp}`,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });

    if (!ipRateLimit.allowed) {
      apiLogger.warn({ msg: "auth/forgot-password:rate-limited", retryAfterSeconds: ipRateLimit.retryAfterSeconds, ip: clientIp });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds) },
        }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      apiLogger.warn({ msg: "auth/forgot-password:invalid-json-body", ip: clientIp });
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const validated = forgotPasswordSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "auth/forgot-password:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const email = validated.data.email.toLowerCase();
    const eventSlug = validated.data.eventSlug;

    // Verify the event exists before binding the reset link to it.
    // Soft fallback: if the slug doesn't match any event in the DB,
    // log a warning + drop back to the generic reset path so the
    // user gets a working link instead of one that 404s. Defends
    // against a malicious or buggy client posting an arbitrary slug
    // string that would produce a broken email.
    //
    // We use findUnique (slug is unique on Event) + select only the
    // slug to keep the query cheap. The DB-canonical slug is what
    // we use downstream — preserves case + format from the source
    // of truth.
    // Note: Event.slug is unique PER organization (compound unique
    // `organizationId_slug`), not globally. findFirst lets us look
    // up the slug across all orgs — the multi-org collision case is
    // theoretical at current single-org scale, but if it ever
    // happens, falling back to "first match by slug" is safe because
    // the slug only drives the reset URL's branding path. The
    // password reset itself is still gated by the email + token,
    // which are user-bound regardless of which event's branding
    // appears on the reset page.
    let verifiedEventSlug: string | undefined;
    if (eventSlug) {
      try {
        const event = await db.event.findFirst({
          where: { slug: eventSlug },
          select: { slug: true },
        });
        if (event) {
          verifiedEventSlug = event.slug;
        } else {
          apiLogger.warn({
            msg: "auth/forgot-password:unknown-event-slug",
            email,
            eventSlug,
          });
        }
      } catch (err) {
        // DB lookup failed — don't fail the whole reset flow; just
        // fall back to the generic link and log so we can investigate.
        apiLogger.warn({
          msg: "auth/forgot-password:event-slug-lookup-failed",
          err,
          eventSlug,
        });
      }
    }
    const emailRateLimit = checkRateLimit({
      key: `forgot-password:email:${email}`,
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });

    if (!emailRateLimit.allowed) {
      apiLogger.warn({ msg: "auth/forgot-password:rate-limited", retryAfterSeconds: emailRateLimit.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(emailRateLimit.retryAfterSeconds) },
        }
      );
    }

    const user = await db.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        organizationId: true,
      },
    });

    // Always return success to prevent account enumeration
    if (!user) {
      return NextResponse.json({
        success: true,
        message: "If an account exists, a password reset link has been sent.",
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashVerificationToken(token);
    const tokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    const identifier = getPasswordResetIdentifier(email);

    await db.$transaction(async (tx) => {
      await tx.verificationToken.deleteMany({ where: { identifier } });

      await tx.verificationToken.create({
        data: {
          identifier,
          token: tokenHash,
          expires: tokenExpiry,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "FORGOT_PASSWORD_REQUESTED",
          entityType: "User",
          entityId: user.id,
          changes: { email, ip: getClientIp(req) },
        },
      });
    });

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      "http://localhost:3000";
    // Build the reset link with event-scoped path ONLY when the
    // slug was both Zod-validated AND confirmed to exist in the DB.
    // Otherwise fall back to the generic /reset-password path so
    // the email link always works.
    const resetPath = verifiedEventSlug
      ? `/e/${encodeURIComponent(verifiedEventSlug)}/reset-password`
      : `/reset-password`;
    const resetLink = `${appUrl}${resetPath}?token=${token}&email=${encodeURIComponent(email)}`;

    const emailTemplate = emailTemplates.passwordReset({
      recipientName: `${user.firstName} ${user.lastName}`,
      resetLink,
      expiresIn: "1 hour",
    });

    // Send email synchronously to ensure delivery before responding.
    // We still return the same "success" message regardless to prevent account enumeration.
    try {
      const emailResult = await sendEmail({
        to: [{ email: user.email, name: `${user.firstName} ${user.lastName}` }],
        subject: emailTemplate.subject,
        htmlContent: emailTemplate.htmlContent,
        textContent: emailTemplate.textContent,
        emailType: "password_reset",
        stream: "transactional",
        logContext: {
          organizationId: user.organizationId ?? null,
          entityType: "USER",
          entityId: user.id,
          templateSlug: "password-reset",
        },
      });

      if (!emailResult.success) {
        apiLogger.warn({
          msg: "Failed to send password reset email",
          email,
          error: emailResult.error,
        });
      }
    } catch (sendError) {
      apiLogger.warn({
        msg: "Password reset email dispatch error",
        email,
        error: sendError instanceof Error ? sendError.message : "Unknown error",
      });
    }

    return NextResponse.json({
      success: true,
      message: "If an account exists, a password reset link has been sent.",
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error requesting password reset" });
    return NextResponse.json(
      { error: "Failed to request password reset" },
      { status: 500 }
    );
  }
}
