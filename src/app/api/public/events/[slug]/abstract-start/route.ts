import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
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
      where: { OR: [{ slug }, { id: slug }] },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const user = await db.user.findUnique({
      where: { email: emailLower },
      select: { id: true, role: true, passwordHash: true, firstName: true, lastName: true, termsAcceptedAt: true },
    });
    // Generic message — don't reveal whether the email exists vs. wrong password.
    if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      apiLogger.warn({ msg: "public/abstract-start:bad-credentials", email: emailLower, ip });
      return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
    }

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
            specialty: true, registrationType: true, additionalEmail: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    const att = registration?.attendee ?? null;
    const firstName = att?.firstName || user.firstName || "";
    const lastName = att?.lastName || user.lastName || "";

    let speakerId = "";
    await db.$transaction(async (tx) => {
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
        email: emailLower,
        userId: user.id,
        overwriteExisting: false,
        profile: {
          firstName,
          lastName,
          title: att?.title ?? null,
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
        },
      });
    });

    // Companion registration (badge / check-in parity) — failure-isolated, and
    // a no-op when the speaker already points at a registration.
    try {
      await ensureSpeakerCompanionRegistration({
        id: speakerId,
        eventId: event.id,
        email: emailLower,
        firstName,
        lastName,
        title: att?.title ?? null,
        additionalEmail: att?.additionalEmail ?? null,
        organization: att?.organization ?? null,
        jobTitle: att?.jobTitle ?? null,
        phone: att?.phone ?? null,
        city: att?.city ?? null,
        state: att?.state ?? null,
        zipCode: att?.zipCode ?? null,
        country: att?.country ?? null,
        specialty: att?.specialty ?? null,
      });
    } catch (err) {
      apiLogger.warn({ msg: "public/abstract-start:companion-failed", eventId: event.id, speakerId, err });
    }

    apiLogger.info({ msg: "public/abstract-start:ready", eventId: event.id, email: emailLower, wasRegistrant });
    return NextResponse.json({ ok: true, eventId: event.id, wasRegistrant });
  } catch (error) {
    apiLogger.error({ err: error, msg: "abstract-start failed" });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
