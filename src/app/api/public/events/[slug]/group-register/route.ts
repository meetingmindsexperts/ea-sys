import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
import { isTrustedInternalEmail, needsEmailVerification } from "@/lib/internal-domains";
import { sendEmailVerification } from "@/lib/email-verification";
import { notifyEventAdmins } from "@/lib/notifications";
import {
  readGroupRegistrationSettings,
  GROUP_MEMBERS_HARD_CEILING,
} from "@/lib/group-registration-settings";
import {
  createGroupRegistration,
  type CreateGroupRegistrationErrorCode,
} from "@/services/group-registration-service";

/**
 * Public group registration (docs/GROUP_REGISTRATION_PLAN.md, Phase 1).
 *
 * A company coordinator registers N members with ONE payer + ONE consolidated
 * invoice (pay-later v1 — card checkout is Phase 2). Link-only entry: the
 * organizer copies the URL from Event Settings; the register page does not
 * advertise it.
 *
 * The coordinator gets (or signs into) a REGISTRANT account: an existing
 * account requires the correct password (bad credentials → 401, the
 * abstract-start door pattern); a new one is created REGISTRANT/org-null
 * (trusted internal domains org-attach, verified domains get a verify link —
 * mirrors ensureRegistrantAccount, but runs PRE-create because the group row
 * links `coordinatorUserId`).
 */

const memberAttendeeSchema = z.object({
  title: titleEnum.optional(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().max(255),
  additionalEmail: z.string().email().max(255).optional().or(z.literal("").transform(() => undefined)),
  // The owner-locked rule: coordinators enter the FULL public field-set per
  // person (incl. role) — same required set as the public register form.
  organization: z.string().min(1).max(255),
  jobTitle: z.string().min(1).max(255),
  phone: z.string().min(1).max(50),
  city: z.string().min(1).max(100),
  state: z.string().max(100).optional(),
  zipCode: z.string().max(20).optional(),
  country: z.string().min(1).max(100),
  role: attendeeRoleEnum,
  specialty: z.string().min(1).max(255),
  customSpecialty: z.string().max(255).optional(),
}).refine((a) => a.specialty !== "Others" || !!a.customSpecialty?.trim(), {
  message: "Custom specialty is required when specialty is 'Others'",
  path: ["customSpecialty"],
});

const groupRegisterSchema = z.object({
  coordinator: z.object({
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    email: z.string().email().max(255),
    password: z.string().min(8).max(200),
    attending: z.boolean(),
  }),
  payer: z.object({
    name: z.string().min(2).max(255),
    contactName: z.string().max(255).optional(),
    email: z.string().email().max(255).optional().or(z.literal("").transform(() => undefined)),
    phone: z.string().max(50).optional(),
    address: z.string().max(500).optional(),
    city: z.string().max(100).optional(),
    country: z.string().max(100).optional(),
    taxNumber: z.string().max(100).optional(),
  }),
  payerReference: z.string().max(200).optional(),
  members: z
    .array(z.object({ ticketTypeId: z.string().min(1), attendee: memberAttendeeSchema }))
    .min(1)
    .max(GROUP_MEMBERS_HARD_CEILING),
});

const ERROR_STATUS: Record<CreateGroupRegistrationErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  GROUP_DISABLED: 403,
  GROUP_SIZE_OUT_OF_BOUNDS: 400,
  TICKET_TYPE_NOT_FOUND: 400,
  TICKET_TYPE_IS_FACULTY: 400,
  SALES_NOT_STARTED: 400,
  SALES_ENDED: 400,
  DUPLICATE_IN_GROUP: 400,
  ALREADY_REGISTERED: 409,
  SOLD_OUT: 409,
  EVENT_FULL: 409,
  PAYER_INVALID: 400,
  MIXED_CURRENCY: 400,
  UNKNOWN: 500,
};

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;
    const clientIp = getClientIp(req);

    // Rate limits mirror the public register (burst + sustained per IP).
    const burst = checkRateLimit({ key: `group-register-burst:${clientIp}`, limit: 15, windowMs: 60 * 1000 });
    if (!burst.allowed) {
      apiLogger.warn({ msg: "public/group-register:rate-limited-burst", ip: clientIp, slug });
      return NextResponse.json(
        { error: "Too many requests. Please try again shortly.", retryAfterSeconds: burst.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(burst.retryAfterSeconds) } },
      );
    }
    const sustained = checkRateLimit({ key: `group-register:${clientIp}`, limit: 30, windowMs: 15 * 60 * 1000 });
    if (!sustained.allowed) {
      apiLogger.warn({ msg: "public/group-register:rate-limited", ip: clientIp, slug });
      return NextResponse.json(
        { error: "Too many requests. Please try again later.", retryAfterSeconds: sustained.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(sustained.retryAfterSeconds) } },
      );
    }

    const body = await req.json();
    const parsed = groupRegisterSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "public/group-register:invalid-input", slug, errors: parsed.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const data = parsed.data;
    const coordinatorEmail = data.coordinator.email.trim().toLowerCase();

    // Per-coordinator-email limit (a stuck retry loop can't spam accounts).
    const emailLimit = checkRateLimit({ key: `group-register-email:${coordinatorEmail}`, limit: 10, windowMs: 15 * 60 * 1000 });
    if (!emailLimit.allowed) {
      apiLogger.warn({ msg: "public/group-register:rate-limited-email", slug, ip: clientIp });
      return NextResponse.json(
        { error: "Too many attempts for this email. Please try again later.", retryAfterSeconds: emailLimit.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(emailLimit.retryAfterSeconds) } },
      );
    }

    // Review M8: member-count budget per IP — each member triggers a
    // confirmation email, so the per-REQUEST limits alone allow ~50× the
    // individual-register email volume. Charge the limiter once PER MEMBER
    // (150 members/hr/IP) so a burst of max-size groups can't turn the door
    // into an SES-reputation / harassment amplifier.
    for (let i = 0; i < data.members.length; i++) {
      const memberBudget = checkRateLimit({ key: `group-register-members:${clientIp}`, limit: 150, windowMs: 60 * 60 * 1000 });
      if (!memberBudget.allowed) {
        apiLogger.warn({ msg: "public/group-register:member-budget-exceeded", ip: clientIp, slug });
        return NextResponse.json(
          { error: "Too many registrations from this connection. Please try again later.", retryAfterSeconds: memberBudget.retryAfterSeconds },
          { status: 429, headers: { "Retry-After": String(memberBudget.retryAfterSeconds) } },
        );
      }
    }

    // Coordinator-attending consistency: their row must be in members.
    const memberEmails = data.members.map((m) => m.attendee.email.trim().toLowerCase());
    if (data.coordinator.attending && !memberEmails.includes(coordinatorEmail)) {
      apiLogger.warn({ msg: "public/group-register:coordinator-member-missing", slug });
      return NextResponse.json(
        {
          error: "You marked yourself as attending, but your details are not in the member list.",
          code: "COORDINATOR_MEMBER_MISSING",
        },
        { status: 400 },
      );
    }
    if (!data.coordinator.attending && memberEmails.includes(coordinatorEmail)) {
      apiLogger.warn({ msg: "public/group-register:coordinator-member-conflict", slug });
      return NextResponse.json(
        {
          error: "You marked yourself as not attending, but your email is in the member list.",
          code: "COORDINATOR_MEMBER_CONFLICT",
        },
        { status: 400 },
      );
    }

    // Resolve the event (slug or id; tenant-scoped by host).
    const event = await db.event.findFirst({
      where: await publicEventWhere(req, slug, {
        allowIdFallback: true,
        statuses: ["PUBLISHED", "LIVE"],
      }),
      select: { id: true, name: true, organizationId: true, settings: true, slug: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "public/group-register:event-not-found", slug });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
      // Enablement gate (defense in depth — the service re-checks).
      const settings = readGroupRegistrationSettings(event.settings);
      if (!settings.enabled) {
        apiLogger.warn({ msg: "public/group-register:disabled", slug, eventId: event.id });
        return NextResponse.json(
          { error: "Group registration is not open for this event.", code: "GROUP_DISABLED" },
          { status: 403 },
        );
      }
      // Master registration switch applies to groups too.
      const eventSettings = (event.settings || {}) as Record<string, unknown>;
      if (eventSettings.registrationOpen === false) {
        apiLogger.warn({ msg: "public/group-register:registration-closed", slug, eventId: event.id });
        return NextResponse.json(
          { error: "Registration is closed for this event.", code: "REGISTRATION_CLOSED" },
          { status: 403 },
        );
      }

      // Coordinator account: sign in (existing) or create (new).
      const account = await resolveCoordinatorAccount({
        email: coordinatorEmail,
        password: data.coordinator.password,
        firstName: data.coordinator.firstName,
        lastName: data.coordinator.lastName,
        organizationId: event.organizationId,
        eventId: event.id,
        clientIp,
      });
      if (!account.ok) {
        return NextResponse.json({ error: account.error, code: account.code }, { status: account.status });
      }

      const result = await createGroupRegistration({
        eventId: event.id,
        organizationId: event.organizationId,
        coordinatorUserId: account.userId,
        coordinator: {
          name: `${data.coordinator.firstName} ${data.coordinator.lastName}`.trim(),
          email: coordinatorEmail,
        },
        coordinatorAttending: data.coordinator.attending,
        payer: data.payer,
        payerReference: data.payerReference ?? null,
        members: data.members,
        requestIp: clientIp,
      });

      if (!result.ok) {
        // Service already logged; the route boundary maps code → status.
        return NextResponse.json(
          { error: result.message, code: result.code, ...(result.meta ? { meta: result.meta } : {}) },
          { status: ERROR_STATUS[result.code] ?? 500 },
        );
      }

      return NextResponse.json(
        {
          success: true,
          groupId: result.group.groupId,
          memberCount: result.group.memberCount,
          subtotal: result.group.subtotal,
          currency: result.group.currency,
          invoiceNumber: result.group.invoiceNumber,
          members: result.group.members.map((m) => ({
            serialId: m.serialId,
            email: m.email,
            firstName: m.firstName,
            lastName: m.lastName,
            ticketTypeName: m.ticketTypeName,
          })),
        },
        { status: 201 },
      );
    });
  } catch (err) {
    apiLogger.error({ err, msg: "public/group-register:failed" });
    return NextResponse.json({ error: "Failed to create the group registration" }, { status: 500 });
  }
}

// ── Coordinator account resolve (pre-create — the group row links userId) ────

async function resolveCoordinatorAccount(args: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  organizationId: string;
  eventId: string;
  clientIp: string | null;
}): Promise<
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string; code: string }
> {
  const { email, password } = args;
  const existing = await db.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, termsAcceptedAt: true },
  });

  if (existing) {
    if (!existing.passwordHash || !(await bcrypt.compare(password, existing.passwordHash))) {
      // No email in the log line — login-audit keeps addresses in its own
      // table; the broad log feed doesn't get PII (review L5).
      apiLogger.warn({ msg: "public/group-register:bad-credentials", ip: args.clientIp });
      return {
        ok: false,
        status: 401,
        error: "An account with this email already exists — the password is incorrect. Sign in with your existing password.",
        code: "BAD_CREDENTIALS",
      };
    }
    if (!existing.termsAcceptedAt) {
      await db.user.update({
        where: { id: existing.id },
        data: { termsAcceptedAt: new Date(), termsAcceptedIp: args.clientIp },
      });
    }
    return { ok: true, userId: existing.id };
  }

  const passwordHash = await bcrypt.hash(password, 10);
  let user: { id: string };
  try {
    user = await db.user.create({
    data: {
      email,
      passwordHash,
      firstName: args.firstName,
      lastName: args.lastName,
      role: "REGISTRANT",
      // Same internal-domain tiers as ensureRegistrantAccount.
      organizationId: isTrustedInternalEmail(email) ? args.organizationId : null,
      termsAcceptedAt: new Date(),
      termsAcceptedIp: args.clientIp,
    },
    select: { id: true },
    });
  } catch (err) {
    // P2002 race: two first-time submissions with the same email — the loser
    // re-resolves as a sign-in against the winner's row (review L6).
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      apiLogger.warn({ msg: "public/group-register:account-create-race", ip: args.clientIp });
      const winner = await db.user.findUnique({ where: { email }, select: { id: true, passwordHash: true } });
      if (winner?.passwordHash && (await bcrypt.compare(password, winner.passwordHash))) {
        return { ok: true, userId: winner.id };
      }
      return {
        ok: false,
        status: 401,
        error: "An account with this email already exists — the password is incorrect. Sign in with your existing password.",
        code: "BAD_CREDENTIALS",
      };
    }
    throw err;
  }
  if (needsEmailVerification(email)) {
    void sendEmailVerification({ email, name: `${args.firstName} ${args.lastName}` });
  }
  notifyEventAdmins(args.eventId, {
    type: "SIGNUP",
    title: "New Account Signup",
    message: `${args.firstName} ${args.lastName} (${email}) created an account as a group coordinator.`,
    link: `/events/${args.eventId}/registrations`,
  }).catch((err) =>
    apiLogger.warn({ err, msg: "public/group-register:notify-admins-failed", eventId: args.eventId }),
  );
  return { ok: true, userId: user.id };
}
