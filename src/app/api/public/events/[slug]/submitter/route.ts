import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";
import { notifyEventAdmins } from "@/lib/notifications";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom, brandingCc } from "@/lib/email";

const registerSchema = z.object({
  title: titleEnum,
  role: attendeeRoleEnum,
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  email: z.string().email("Valid email is required").max(255),
  additionalEmail: z.string().email().max(255).optional().or(z.literal("")),
  password: z.string().min(6, "Password must be at least 6 characters").max(128),
  state: z.string().max(255).optional(),
  zipCode: z.string().max(20).optional(),
  organization: z.string().min(1, "Organization is required").max(255),
  jobTitle: z.string().min(1, "Position is required").max(255),
  phone: z.string().min(1, "Mobile number is required").max(50),
  city: z.string().min(1, "City is required").max(255),
  country: z.string().min(1, "Country is required").max(255),
  specialty: z.string().min(1, "Specialty is required").max(255),
  customSpecialty: z.string().max(255).optional(),
  registrationType: z.string().max(255).optional(),
}).refine(
  (data) => data.specialty !== "Others" || (data.customSpecialty?.trim().length ?? 0) > 0,
  {
    message: "Please specify your specialty",
    path: ["customSpecialty"],
  },
);

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
      select: { id: true, role: true, termsAcceptedAt: true },
    });

    // Allow REGISTRANT to upgrade to SUBMITTER; reject other existing roles
    if (existingUser && existingUser.role !== "REGISTRANT") {
      return NextResponse.json(
        { error: "An account with this email already exists. Please log in instead." },
        { status: 409 }
      );
    }

    // Hash password
    const passwordHash = await bcrypt.hash(data.password, 10);

    // Create user + speaker in a transaction
    await db.$transaction(async (tx) => {
      let user: { id: string };

      const clientIpForTerms = getClientIp(req);

      if (existingUser) {
        // Upgrade REGISTRANT → SUBMITTER + record terms if first time
        user = await tx.user.update({
          where: { id: existingUser.id },
          data: {
            role: "SUBMITTER",
            firstName: data.firstName,
            lastName: data.lastName,
            ...(!existingUser.termsAcceptedAt && {
              termsAcceptedAt: new Date(),
              termsAcceptedIp: clientIpForTerms,
            }),
          },
          select: { id: true },
        });
      } else {
        // Create new SUBMITTER user (org-independent)
        user = await tx.user.create({
          data: {
            email: emailLower,
            passwordHash,
            firstName: data.firstName,
            lastName: data.lastName,
            role: "SUBMITTER",
            emailVerified: new Date(),
            termsAcceptedAt: new Date(),
            termsAcceptedIp: clientIpForTerms,
          },
          select: { id: true },
        });
      }

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
            title: data.title,
            role: data.role,
            firstName: data.firstName,
            lastName: data.lastName,
            additionalEmail: data.additionalEmail || null,
            organization: data.organization,
            jobTitle: data.jobTitle,
            phone: data.phone,
            city: data.city,
            state: data.state || null,
            zipCode: data.zipCode || null,
            country: data.country,
            specialty: data.specialty,
            customSpecialty: data.customSpecialty || null,
            ...(data.registrationType && { registrationType: data.registrationType }),
          },
        });
      } else {
        await tx.speaker.create({
          data: {
            eventId: event.id,
            userId: user.id,
            title: data.title,
            role: data.role,
            email: emailLower,
            additionalEmail: data.additionalEmail || null,
            firstName: data.firstName,
            lastName: data.lastName,
            organization: data.organization,
            jobTitle: data.jobTitle,
            phone: data.phone,
            city: data.city,
            state: data.state || null,
            zipCode: data.zipCode || null,
            country: data.country,
            specialty: data.specialty,
            customSpecialty: data.customSpecialty || null,
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
      title: data.title,
      role: data.role,
      additionalEmail: data.additionalEmail || null,
      organization: data.organization,
      jobTitle: data.jobTitle,
      phone: data.phone,
      city: data.city,
      state: data.state || null,
      zipCode: data.zipCode || null,
      country: data.country,
      specialty: data.specialty,
      customSpecialty: data.customSpecialty || null,
      registrationType: data.registrationType || null,
    });

    apiLogger.info({
      msg: "Submitter account created",
      eventId: event.id,
      email: emailLower,
    });

    // Notify admins of new signup (non-blocking)
    notifyEventAdmins(event.id, {
      type: "SIGNUP",
      title: "New Account Signup",
      message: `${data.firstName} ${data.lastName} (${emailLower}) created a submitter account`,
      link: `/events/${event.id}/speakers`,
    }).catch((err) => apiLogger.warn({ err, msg: "submitter:notify-admins-failed" }));

    // Resolve the speaker id so the welcome email log row links back to the
    // speaker's detail sheet (Email History card).
    const speakerRow = await db.speaker.findUnique({
      where: { eventId_email: { eventId: event.id, email: emailLower } },
      select: { id: true },
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
        cc: brandingCc(branding, [{ email: emailLower }], [data.additionalEmail || null]),
        ...rendered,
        from: brandingFrom(branding),
        logContext: {
          organizationId: event.organizationId,
          eventId: event.id,
          entityType: "SPEAKER",
          entityId: speakerRow?.id ?? null,
          templateSlug: "submitter-welcome",
        },
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
