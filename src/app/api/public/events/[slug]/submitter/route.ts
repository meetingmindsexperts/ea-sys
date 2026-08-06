import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";
import { notifyEventAdmins } from "@/lib/notifications";
import { ensureSpeakerCompanionRegistration, upsertEventSpeaker } from "@/lib/speaker-companion";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom, brandingCc } from "@/lib/email";
import { getTitleLabel } from "@/lib/utils";
import { isDeadlinePassed, readSessionProposalDeadline } from "@/lib/submission-deadline";

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
  // Which public flow is registering: "abstract" (default — the historical
  // behavior) or "proposal" (the session-proposal register page). Gates below
  // branch on it; the created account/Speaker is identical either way.
  source: z.enum(["abstract", "proposal"]).default("abstract"),
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

    // Look up event (tenant-scoped by request host)
    const event = await db.event.findFirst({
      where: await publicEventWhere(req, slug, {
        allowIdFallback: true,
        statuses: ["PUBLISHED", "LIVE"],
      }),
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

    // Tenancy sweep: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    const orgId = event.organizationId;
    return await runWithTenant(orgId, async () => {
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

    // The abstract-submissions gate + deadline apply only to ABSTRACT signups.
    // Session-proposal signups (source: "proposal" — the /e/[slug]/proposal/
    // register page) share this route but have no open/close toggle in v1:
    // the organizer controls exposure by sharing the proposer link.
    const settings = (event.settings || {}) as Record<string, unknown>;
    if (data.source !== "proposal") {
      if (settings.allowAbstractSubmissions !== true) {
        apiLogger.warn({ msg: "public/submitter:abstracts-closed", slug, ip: clientIp });
        return NextResponse.json(
          { error: "Abstract submissions are not open for this event" },
          { status: 403 }
        );
      }

      if (settings.abstractDeadline) {
        const deadline = new Date(settings.abstractDeadline as string);
        if (new Date() > deadline) {
          apiLogger.warn({ msg: "public/submitter:deadline-passed", slug, ip: clientIp });
          return NextResponse.json(
            { error: "The abstract submission deadline has passed" },
            { status: 403 }
          );
        }
      }
    } else if (isDeadlinePassed(readSessionProposalDeadline(settings))) {
      // Proposal intake ends automatically at the deadline (Aug 6, 2026).
      apiLogger.warn({ msg: "public/submitter:proposal-deadline-passed", slug, ip: clientIp });
      return NextResponse.json(
        { error: "The session proposal deadline has passed" },
        { status: 403 }
      );
    }

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
      select: { id: true, role: true, termsAcceptedAt: true, passwordHash: true },
    });

    // Allow REGISTRANT to upgrade to SUBMITTER; reject other existing roles
    if (existingUser && existingUser.role !== "REGISTRANT") {
      return NextResponse.json(
        { error: "An account with this email already exists. Please log in instead." },
        { status: 409 }
      );
    }

    // Ownership check for the REGISTRANT→SUBMITTER upgrade: this POST mutates an
    // EXISTING account (flips role, updates profile, mints a Speaker), so it must
    // prove the caller owns it — verify the account's current password. Without
    // this, anyone who knows a delegate's email could flip their account and
    // overwrite their name from an unauthenticated request.
    if (existingUser) {
      const passwordOk = existingUser.passwordHash
        ? await bcrypt.compare(data.password, existingUser.passwordHash)
        : false;
      if (!passwordOk) {
        apiLogger.warn({ msg: "public/submitter:upgrade-password-mismatch", email: emailLower, ip: clientIp });
        return NextResponse.json(
          { error: "That email already has an account. Enter your existing password to continue, or sign in instead." },
          { status: 401 }
        );
      }
    }

    // Hash password
    const passwordHash = await bcrypt.hash(data.password, 10);

    // Create user + speaker in a transaction
    await tenantTransaction(async (tx) => {
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

      // Find-or-create + link the speaker (shared with abstract-start). Sign-up
      // form → refresh the profile from the submitted details. Values pass
      // through as the original inline block did (empty-string → null to clear;
      // absent title/registrationType → undefined → left unchanged on update).
      await upsertEventSpeaker(tx, {
        eventId: event.id,
        organizationId: event.organizationId,
        email: emailLower,
        userId: user.id,
        overwriteExisting: true,
        profile: {
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
          registrationType: data.registrationType || undefined,
          // Surface separation: which flow this signup came through
          // ("abstract" | "proposal"; a door widens to "both" on an existing
          // speaker).
          submitterSource: data.source,
          // A fresh self-signup (abstract presenter OR proposer) is NOT a
          // confirmed speaker — the team reviews the submission and confirms
          // by hand (owner decision Aug 5, 2026). Only applies on CREATE; an
          // existing (invited) speaker keeps their organizer-set status.
          status: "INVITED",
        },
      });
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
      select: {
        id: true,
        sourceRegistrationId: true,
        sourceRegistration: { select: { status: true } },
      },
    });

    // Provision the companion registration (the "attendee facet") so a
    // self-registered submitter-speaker still gets a badge / entry barcode /
    // check-in / survey / certificate via the normal registration machinery —
    // mirroring createSpeaker + the import paths. Without this the submitter
    // route's raw speaker.create left these faculty with no scannable code.
    // SESSION-PROPOSAL signups are linkOnly (owner decision Aug 5, 2026): NO
    // auto comp registration — the organizer grants comp or payable per
    // person; an existing same-email registration is still linked.
    // Failure-isolated: a hiccup must NOT fail the account create; the backfill
    // script recovers any that fail.
    if (speakerRow) {
      try {
        await ensureSpeakerCompanionRegistration({
          id: speakerRow.id,
          eventId: event.id,
          email: emailLower,
          firstName: data.firstName,
          lastName: data.lastName,
          title: data.title,
          additionalEmail: data.additionalEmail || null,
          organization: data.organization,
          jobTitle: data.jobTitle,
          phone: data.phone,
          city: data.city,
          state: data.state || null,
          zipCode: data.zipCode || null,
          country: data.country,
          specialty: data.specialty,
          registrationType: data.registrationType || null,
          role: data.role ?? null,
          // A CANCELLED link counts as no link (review LOW, Aug 5 2026 — the
          // grant route already did this): a revoked person who re-registers
          // gets their LIVE registration linked instead of staying pointed at
          // the dead row. The raw pointer still rides as expectedLink so the
          // helper's conditional claim asserts the true current value.
          sourceRegistrationId:
            speakerRow.sourceRegistration?.status === "CANCELLED"
              ? null
              : speakerRow.sourceRegistrationId,
        }, {
          linkOnly: data.source === "proposal",
          expectedLink: speakerRow.sourceRegistrationId,
        });
      } catch (err) {
        apiLogger.error({ err, speakerId: speakerRow.id, eventId: event.id }, "submitter:companion-failed");
      }
    }

    // Send welcome email (non-blocking)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const vars = {
      title: getTitleLabel(data.title),
      firstName: data.firstName,
      lastName: data.lastName,
      eventName: event.name,
      loginLink: `${appUrl}/login`,
    };
    // Proposal signups get the proposal-worded welcome ("propose a session"),
    // abstract signups keep the historical submitter-welcome.
    const welcomeSlug =
      data.source === "proposal" ? "session-proposal-welcome" : "submitter-welcome";
    getEventTemplate(event.id, welcomeSlug).then((tpl) => {
      const t = tpl || getDefaultTemplate(welcomeSlug);
      if (!t) { apiLogger.warn({ msg: `No template found for ${welcomeSlug}` }); return; }
      const branding = tpl?.branding || { eventName: event.name };
      const rendered = renderAndWrap(t, vars, branding);
      return sendEmail({
        to: [{ email: emailLower, name: data.firstName }],
        cc: brandingCc(branding, [{ email: emailLower }], [data.additionalEmail || null]),
        ...rendered,
        from: brandingFrom(branding),
        emailType: "submitter_welcome",
        stream: "transactional",
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
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating submitter account" });
    return NextResponse.json(
      { error: "Failed to create account" },
      { status: 500 }
    );
  }
}
