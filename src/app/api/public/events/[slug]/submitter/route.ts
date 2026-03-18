import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { titleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap } from "@/lib/email";

const registerSchema = z.object({
  title: titleEnum.optional(),
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  email: z.string().email("Valid email is required").max(255),
  password: z.string().min(6, "Password must be at least 6 characters").max(128),
  organization: z.string().max(255).optional(),
  jobTitle: z.string().max(255).optional(),
  phone: z.string().max(50).optional(),
  city: z.string().max(255).optional(),
  country: z.string().max(255).optional(),
  specialty: z.string().max(255).optional(),
  registrationType: z.string().max(255).optional(),
});

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const clientIp = getClientIp(req);

    // Burst limiter: catch bots hammering the endpoint (3 req / 60s per IP)
    const burstLimit = checkRateLimit({
      key: `submitter-register:burst:${clientIp}`,
      limit: 3,
      windowMs: 60 * 1000,
    });
    if (!burstLimit.allowed) {
      apiLogger.warn({ msg: "Submitter registration burst rate limit hit", ip: clientIp });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(burstLimit.retryAfterSeconds) } }
      );
    }

    // Sustained limiter: 10 submissions per IP per 15 min (covers shared WiFi)
    const ipRateLimit = checkRateLimit({
      key: `submitter-register:ip:${clientIp}`,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });

    if (!ipRateLimit.allowed) {
      apiLogger.warn({ msg: "Submitter registration IP rate limit hit", ip: clientIp });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds) } }
      );
    }

    const { slug } = await params;

    // Look up event
    const event = await db.event.findFirst({
      where: {
        OR: [{ slug }, { id: slug }],
        status: { in: ["PUBLISHED", "LIVE"] },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        settings: true,
        organizationId: true,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Check abstract submissions are enabled
    const settings = (event.settings || {}) as Record<string, unknown>;
    if (settings.allowAbstractSubmissions !== true) {
      return NextResponse.json(
        { error: "Abstract submissions are not open for this event" },
        { status: 403 }
      );
    }

    // Check deadline
    if (settings.abstractDeadline) {
      const deadline = new Date(settings.abstractDeadline as string);
      if (new Date() > deadline) {
        return NextResponse.json(
          { error: "The abstract submission deadline has passed" },
          { status: 403 }
        );
      }
    }

    const body = await req.json();
    const validated = registerSchema.safeParse(body);

    if (!validated.success) {
      const details = validated.error.flatten();
      apiLogger.warn({ msg: "Submitter registration validation failed", slug, errors: details });
      return NextResponse.json(
        { error: "Invalid input", details },
        { status: 400 }
      );
    }

    const data = validated.data;
    const emailLower = data.email.toLowerCase();

    const emailRateLimit = checkRateLimit({
      key: `submitter-register:email:${emailLower}`,
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });

    if (!emailRateLimit.allowed) {
      apiLogger.warn({ msg: "Submitter registration email rate limit hit", email: emailLower, ip: clientIp });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(emailRateLimit.retryAfterSeconds) } }
      );
    }

    // Check if email is already taken
    const existingUser = await db.user.findUnique({
      where: { email: emailLower },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "An account with this email already exists. Please log in instead." },
        { status: 409 }
      );
    }

    // Hash password
    const passwordHash = await bcrypt.hash(data.password, 10);

    // Create user + speaker in a transaction
    await db.$transaction(async (tx) => {
      // Create SUBMITTER user (org-independent)
      const user = await tx.user.create({
        data: {
          email: emailLower,
          passwordHash,
          firstName: data.firstName,
          lastName: data.lastName,
          role: "SUBMITTER",
          emailVerified: new Date(),
        },
      });

      // Find or create speaker linked to this event
      const existingSpeaker = await tx.speaker.findUnique({
        where: {
          eventId_email: {
            eventId: event.id,
            email: emailLower,
          },
        },
      });

      if (existingSpeaker) {
        await tx.speaker.update({
          where: { id: existingSpeaker.id },
          data: {
            userId: user.id,
            ...(data.title && { title: data.title }),
            firstName: data.firstName,
            lastName: data.lastName,
            ...(data.organization && { organization: data.organization }),
            ...(data.jobTitle && { jobTitle: data.jobTitle }),
            ...(data.phone && { phone: data.phone }),
            ...(data.city && { city: data.city }),
            ...(data.country && { country: data.country }),
            ...(data.specialty && { specialty: data.specialty }),
            ...(data.registrationType && { registrationType: data.registrationType }),
          },
        });
      } else {
        await tx.speaker.create({
          data: {
            eventId: event.id,
            userId: user.id,
            title: data.title || null,
            email: emailLower,
            firstName: data.firstName,
            lastName: data.lastName,
            organization: data.organization || null,
            jobTitle: data.jobTitle || null,
            phone: data.phone || null,
            city: data.city || null,
            country: data.country || null,
            specialty: data.specialty || null,
            registrationType: data.registrationType || null,
            status: "CONFIRMED",
          },
        });
      }
    });

    // Sync submitter to org contact store (awaited — errors caught internally)
    await syncToContact({
      organizationId: event.organizationId,
      eventId: event.id,
      email: emailLower,
      firstName: data.firstName,
      lastName: data.lastName,
      title: data.title || null,
      organization: data.organization || null,
      jobTitle: data.jobTitle || null,
      phone: data.phone || null,
      city: data.city || null,
      country: data.country || null,
      specialty: data.specialty || null,
      registrationType: data.registrationType || null,
    });

    apiLogger.info({
      msg: "Submitter account created",
      eventId: event.id,
      email: emailLower,
    });

    // Send welcome email (non-blocking)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const vars = {
      firstName: data.firstName,
      lastName: data.lastName,
      eventName: event.name,
      loginLink: `${appUrl}/login`,
    };
    getEventTemplate(event.id, "submitter-welcome").then((tpl) => {
      const t = tpl || getDefaultTemplate("submitter-welcome");
      if (!t) { apiLogger.warn({ msg: "No template found for submitter-welcome" }); return; }
      const branding = tpl?.branding || { eventName: event.name };
      const rendered = renderAndWrap(t, vars, branding);
      return sendEmail({
        to: [{ email: emailLower, name: data.firstName }],
        ...rendered,
      });
    }).catch((err) => apiLogger.error({ err, msg: "Failed to send submitter welcome email" }));

    return NextResponse.json({
      success: true,
      message: "Account created successfully. Please log in to submit your abstract.",
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating submitter account" });
    return NextResponse.json(
      { error: "Failed to create account" },
      { status: 500 }
    );
  }
}
