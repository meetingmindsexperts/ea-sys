import { NextResponse } from "next/server";
import { z } from "zod";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { verifyPublicCredentials } from "@/lib/public-credential-door";
import { readUserAgent } from "@/lib/login-audit";
import { ensureSpeakerCompanionRegistration, upsertEventSpeaker } from "@/lib/speaker-companion";

/**
 * "Start an abstract as an EXISTING user" — the sign-in half of the abstract
 * submission flow. Given a valid email + password for an existing account it:
 *   1. verifies the password (proves ownership — same guard as the submitter
 *      route's upgrade path),
 *   2. upgrades a REGISTRANT → SUBMITTER so middleware lets them into the
 *      dashboard abstracts area,
 *   3. ensures a Speaker exists for this event, PREFILLED from the person's
 *      existing registration (attendee) so they never re-type their details —
 *      the new-abstract form then auto-uses it as the author.
 *
 * The client calls this FIRST, then `signIn(...)`, so the freshly-minted JWT
 * already carries the upgraded role (no stale-token bounce to /my-registration),
 * then routes straight to /events/[id]/abstracts/new.
 */
const bodySchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
  // Which public flow the sign-in came from — stamps Speaker.submitterSource
  // (first flow wins) for the submitter surface separation. Despite this
  // route's historical name it serves BOTH the abstract and the session-
  // proposal register pages' existing-account paths.
  source: z.enum(["abstract", "proposal"]).default("abstract"),
});

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;
    const ip = getClientIp(req);

    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "public/abstract-start:invalid-input", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }
    const emailLower = parsed.data.email.toLowerCase();
    const { password } = parsed.data;

    // Password-guessing guard (per email). Modest ceiling — this is a real
    // credential check on a public route.
    const rate = checkRateLimit({ key: `abstract-start:${emailLower}`, limit: 8, windowMs: 15 * 60 * 1000 });
    if (!rate.allowed) {
      apiLogger.warn({ msg: "public/abstract-start:rate-limited", email: emailLower, ip });
      return NextResponse.json(
        { error: "Too many attempts. Please try again later." },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
      );
    }

    const event = await db.event.findFirst({
      where: await publicEventWhere(req, slug, { allowIdFallback: true }),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Tenancy sweep: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    const orgId = event.organizationId;
    return await runWithTenant(orgId, async () => {
    const existingUser = await db.user.findUnique({
      where: { email: emailLower },
      select: {
        id: true, role: true, passwordHash: true, organizationId: true,
        firstName: true, lastName: true, termsAcceptedAt: true,
      },
    });
    // Review M7: throttled + audited like any other credential check.
    // recordSuccess is FALSE here — the client calls NextAuth signIn()
    // immediately after a 200, and authorize() writes the SUCCESS row for that
    // same human sign-in; recording one here too would double every one of them
    // in Sign-in Activity. Failures ARE recorded: a 401 stops the client before
    // signIn(), so nothing else would ever see them.
    const check = await verifyPublicCredentials({
      email: emailLower,
      password,
      user: existingUser,
      ipAddress: ip,
      userAgent: readUserAgent(req),
      surface: "EVENT_PAGE",
      recordSuccess: false,
      logLabel: "public/abstract-start",
    });
    if (!check.ok) {
      if (check.reason === "throttled") {
        return NextResponse.json(
          { error: "Too many failed sign-in attempts. Please try again later.", code: "LOGIN_THROTTLED" },
          { status: 429, headers: { "Retry-After": String(check.retryAfterSeconds) } },
        );
      }
      // Generic message — don't reveal whether the email exists vs. wrong password.
      return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
    }
    // Non-null by the guard's contract (a pass means there IS an account), so
    // the rest of the handler keeps working with a plain `user`.
    const user = check.user;

    const wasRegistrant = user.role === "REGISTRANT";

    // Prefill source: this person's existing (non-cancelled) registration on
    // this event, if any.
    const registration = await db.registration.findFirst({
      where: {
        eventId: event.id,
        status: { not: "CANCELLED" },
        OR: [{ userId: user.id }, { attendee: { email: emailLower } }],
      },
      select: {
        id: true,
        attendee: {
          select: {
            title: true, firstName: true, lastName: true, organization: true, jobTitle: true,
            phone: true, city: true, state: true, zipCode: true, country: true,
            specialty: true, registrationType: true, role: true, additionalEmail: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    const att = registration?.attendee ?? null;
    const firstName = att?.firstName || user.firstName || "";
    const lastName = att?.lastName || user.lastName || "";

    let speakerId = "";
    await tenantTransaction(async (tx) => {
      if (wasRegistrant) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            role: "SUBMITTER",
            ...(!user.termsAcceptedAt && { termsAcceptedAt: new Date(), termsAcceptedIp: ip }),
          },
        });
      }

      // Sign-in flow: ensure the speaker exists + is linked to this user, but
      // don't clobber an existing profile (overwriteExisting: false).
      speakerId = await upsertEventSpeaker(tx, {
        eventId: event.id,
        organizationId: event.organizationId,
        email: emailLower,
        userId: user.id,
        overwriteExisting: false,
        profile: {
          firstName,
          lastName,
          title: att?.title ?? null,
          role: att?.role ?? null,
          additionalEmail: att?.additionalEmail ?? null,
          organization: att?.organization ?? null,
          jobTitle: att?.jobTitle ?? null,
          phone: att?.phone ?? null,
          city: att?.city ?? null,
          state: att?.state ?? null,
          zipCode: att?.zipCode ?? null,
          country: att?.country ?? null,
          specialty: att?.specialty ?? null,
          registrationType: att?.registrationType ?? null,
          sourceRegistrationId: registration?.id ?? null,
          submitterSource: parsed.data.source,
          // Any fresh self-signup (abstract OR proposal) → INVITED; the team
          // confirms after review (owner decision Aug 5, 2026). CREATE only —
          // an existing speaker's status is never touched.
          status: "INVITED",
        },
      });
    });

    // Companion registration (badge / check-in parity) — failure-isolated, and
    // a no-op when the speaker already points at a registration. SESSION-
    // PROPOSAL sign-ins are linkOnly (owner decision Aug 5, 2026): NO auto
    // comp — the organizer grants comp or payable per person; an existing
    // same-email registration is still linked.
    try {
      await ensureSpeakerCompanionRegistration({
        id: speakerId,
        eventId: event.id,
        email: emailLower,
        firstName,
        lastName,
        title: att?.title ?? null,
        role: att?.role ?? null,
        additionalEmail: att?.additionalEmail ?? null,
        organization: att?.organization ?? null,
        jobTitle: att?.jobTitle ?? null,
        phone: att?.phone ?? null,
        city: att?.city ?? null,
        state: att?.state ?? null,
        zipCode: att?.zipCode ?? null,
        country: att?.country ?? null,
        specialty: att?.specialty ?? null,
      }, { linkOnly: parsed.data.source === "proposal" });
    } catch (err) {
      apiLogger.warn({ msg: "public/abstract-start:companion-failed", eventId: event.id, speakerId, err });
    }

    apiLogger.info({ msg: "public/abstract-start:ready", eventId: event.id, email: emailLower, wasRegistrant });
    return NextResponse.json({ ok: true, eventId: event.id, wasRegistrant });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "abstract-start failed" });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
