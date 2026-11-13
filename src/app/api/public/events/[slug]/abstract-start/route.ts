import { NextResponse } from "next/server";
import { z } from "zod";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { findUserByEmail } from "@/lib/tenant/user-lookup";
import { apiLogger } from "@/lib/logger";
import { sendEmailVerification } from "@/lib/email-verification";
import { loadRegistrantScope, ownRegistrationWhere, speakerClaimPending } from "@/lib/registrant-access";
import { firstGiven, loadOwnDetailSources, OWN_DETAIL_SELECT } from "@/lib/own-details-sources";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { verifyPublicCredentials } from "@/lib/public-credential-door";
import { readUserAgent } from "@/lib/login-audit";
import { upsertEventSpeaker, SpeakerLinkedElsewhereError } from "@/lib/speaker-companion";
import {
  ensureSubmitterRegistration,
  checkPresenterRateSelection,
  holdsLiveRegistration,
  presenterEvidenceShape,
} from "@/lib/presenter-signup";
import { becomesSubmitterToAuthor } from "@/lib/abstract-reviewer-access";
import { presenterDetailsSchema } from "@/lib/schemas";
import { personFieldRefusal } from "@/lib/person-field-rules";

/**
 * "Start an abstract as an EXISTING user" — the sign-in half of the abstract
 * submission flow. Given a valid email + password for an existing account it:
 *   1. verifies the password (proves ownership — same guard as the submitter
 *      route's upgrade path),
 *   2. upgrades a REGISTRANT or REVIEWER → SUBMITTER so middleware lets them into the
 *      dashboard abstracts area,
 *   3. ensures a Speaker exists for this event, PREFILLED from the person's
 *      existing registration (attendee) so they never re-type their details —
 *      the new-abstract form then auto-uses it as the author.
 *
 * The client calls this FIRST, then `signIn(...)`, so the freshly-minted JWT
 * already carries the upgraded role (no stale-token bounce to /my-registration),
 * then routes straight to /events/[id]/abstracts/new.
 *
 * TWO CALLS since Sep 29, 2026 (owner decision). `intent: "lookup"` checks the
 * password and returns the details we already hold, creating nothing; the page
 * shows them on the same details form a new account fills in, with the
 * presenter rates below. `intent: "start"` (the default) then carries the
 * confirmed `details`, which are validated exactly as the new-account door
 * validates them and become this event's speaker and registration. Before this
 * the speaker was built only from a registration on THIS event, so a person
 * whose account came from another event became a speaker with just a name.
 * Edits apply to this event only; the login account is untouched.
 */
const bodySchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
  // Which public flow the sign-in came from — stamps Speaker.submitterSource
  // (first flow wins) for the submitter surface separation. Despite this
  // route's historical name it serves BOTH the abstract and the session-
  // proposal register pages' existing-account paths.
  source: z.enum(["abstract", "proposal"]).default("abstract"),
  /** Presenter rate, for someone signing in who holds no registration yet. */
  ticketTypeId: z.string().max(100).optional(),
  /** The chosen type's ID and document switches decide which of these are required (Nov 4, 2026). */
  ...presenterEvidenceShape,
  /** "lookup" = check the password and return the details on file, nothing else. */
  intent: z.enum(["lookup", "start"]).default("start"),
  /** The details the person confirmed on the page. Absent only from a page
   *  loaded before Sep 29, 2026, which keeps the old on-file behaviour. */
  // Role, Specialty and "Others needs the typed specialty" are demanded as the
  // event's organisation says, once the event is known (below).
  details: presenterDetailsSchema.optional(),
});

/** The detail fields, in the order the form shows them. */
const DETAIL_KEYS = [
  "title", "role", "firstName", "lastName", "additionalEmail", "organization", "jobTitle",
  "phone", "city", "country", "specialty", "customSpecialty",
] as const;
type DetailKey = (typeof DETAIL_KEYS)[number];
type DetailSource = Partial<Record<DetailKey, string | null>> | null | undefined;

/**
 * What to prefill for a person signing in, field by field, from the most
 * specific record that has a value: their speaker profile on this event, their
 * registration on this event, then what they gave elsewhere (the one rule in
 * own-details-sources.ts, shared with the event's My Details), then the
 * account's own name. Only this person's rows are read.
 */
async function loadPresenterPrefill(args: {
  eventId: string;
  userId: string;
  email: string;
  hereAttendee: DetailSource;
  user: { firstName: string | null; lastName: string | null };
}): Promise<Record<DetailKey, string>> {
  // Records found only by address (this or another event's speaker profile, a
  // guest registration) pre-fill nothing until the address is confirmed
  // (registrant-access.ts; security reviews of 7cf4eb3b and 5b870d59): an
  // invited speaker's details are theirs until the address is proven.
  const scope = await loadRegistrantScope(args.userId, "password-checked");
  const confirmed = !!scope?.confirmed;
  const [speakerHere, elsewhere] = await Promise.all([
    db.speaker.findFirst({
      where: { eventId: args.eventId, email: args.email, ...(confirmed ? {} : { userId: args.userId }) },
      select: OWN_DETAIL_SELECT,
    }),
    loadOwnDetailSources({ userId: args.userId, scope, exceptEventId: args.eventId }),
  ]);
  const sources: DetailSource[] = [
    speakerHere,
    args.hereAttendee,
    ...elsewhere,
    { firstName: args.user.firstName, lastName: args.user.lastName },
  ];
  return Object.fromEntries(DETAIL_KEYS.map((key) => [key, firstGiven(sources, key)])) as Record<DetailKey, string>;
}

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
      select: { id: true, organizationId: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (parsed.data.details) {
      const fieldRefusal = await personFieldRefusal(event.organizationId, parsed.data.details);
      if (fieldRefusal) {
        apiLogger.warn({ msg: "public/abstract-start:person-fields-refused", eventId: event.id, fields: Object.keys(fieldRefusal.fieldErrors) });
        // Under `details`, where the form's own errors for these fields sit.
        const fieldErrors = Object.fromEntries(Object.entries(fieldRefusal.fieldErrors).map(([k, v]) => [`details.${k}`, v]));
        return NextResponse.json({ error: "Invalid input", details: { formErrors: [], fieldErrors } }, { status: 400 });
      }
    }

    // Tenancy sweep: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    const orgId = event.organizationId;
    return await runWithTenant(orgId, async () => {
    const existingUser = await findUserByEmail({ organizationId: orgId }, emailLower, {
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

    const becomesSubmitter = becomesSubmitterToAuthor(user.role);

    // Prefill source: this person's existing (non-cancelled) registration on
    // this event, if any, by the My events rule (registrant-access.ts): one
    // matched only by address counts once the address is confirmed.
    const scope = await loadRegistrantScope(user.id, "password-checked");
    const registration = await db.registration.findFirst({
      where: {
        eventId: event.id,
        status: { not: "CANCELLED" },
        ...(scope ? ownRegistrationWhere(scope) : { userId: user.id }),
      },
      select: {
        id: true,
        attendee: {
          select: {
            title: true, firstName: true, lastName: true, organization: true, jobTitle: true,
            phone: true, city: true, state: true, zipCode: true, country: true,
            specialty: true, customSpecialty: true, registrationType: true, role: true,
            additionalEmail: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    const att = registration?.attendee ?? null;

    if (parsed.data.intent === "lookup") {
      const prefill = await loadPresenterPrefill({
        eventId: event.id,
        userId: user.id,
        email: emailLower,
        hereAttendee: att,
        user,
      });
      // Someone already registered here keeps that registration, so the form
      // must not ask them for the chosen type's ID or document.
      const registeredHere = await holdsLiveRegistration(event.id, emailLower);
      apiLogger.info({ msg: "public/abstract-start:lookup", eventId: event.id, userId: user.id });
      return NextResponse.json({ ok: true, prefill, registeredHere });
    }

    // The confirmed details win; without them (a page loaded before Sep 29,
    // 2026) the old on-file behaviour stands.
    const d = parsed.data.details;
    const firstName = d?.firstName || att?.firstName || user.firstName || "";
    const lastName = d?.lastName || att?.lastName || user.lastName || "";
    const profile = d
      ? {
          title: d.title ?? null,
          role: d.role ?? null,
          additionalEmail: d.additionalEmail || null,
          organization: d.organization,
          jobTitle: d.jobTitle,
          phone: d.phone,
          city: d.city,
          state: d.state || null,
          zipCode: d.zipCode || null,
          country: d.country,
          specialty: d.specialty,
          customSpecialty: d.customSpecialty || null,
        }
      : {
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
          customSpecialty: att?.customSpecialty ?? null,
        };

    // Presenter rate: REQUIRED when this event charges presenters (Sep 21,
    // 2026 security review, finding #1). The SAME hole existed on this door as
    // on /submitter — both take `ticketTypeId` as optional and both fell
    // through to the free comp when it was missing.
    //
    // Must run BEFORE the transaction: the registration decision happens in
    // `ensureSubmitterRegistration` below, which is failure-isolated and runs
    // post-commit, so it can never answer this request with a 400.
    const rateCheck = await checkPresenterRateSelection(
      event.id,
      parsed.data.source,
      parsed.data.ticketTypeId,
      { email: emailLower, evidence: parsed.data },
    );
    if (!rateCheck.ok) {
      apiLogger.warn({
        msg: rateCheck.code === "REGISTRATION_TYPE_REQUIRED"
          ? "public/abstract-start:presenter-rate-required"
          : "public/abstract-start:presenter-evidence-missing",
        code: rateCheck.code,
        eventId: event.id,
        chosenTicketTypeId: parsed.data.ticketTypeId ?? null,
        ...("availableCount" in rateCheck && { availableCount: rateCheck.availableCount }),
        ...("fields" in rateCheck && { fields: rateCheck.fields, dropped: rateCheck.dropped ?? null }),
        ip,
      });
      return NextResponse.json(
        { error: rateCheck.message, code: rateCheck.code, ...("fields" in rateCheck && { fields: rateCheck.fields }) },
        { status: 400 },
      );
    }

    if (await speakerClaimPending(event.id, emailLower, !!scope?.confirmed)) {
      apiLogger.info({ msg: "public/abstract-start:speaker-claim-needs-confirmation", eventId: event.id });
      const sent = await sendEmailVerification({ organizationId: event.organizationId, email: emailLower, name: `${firstName} ${lastName}`, purpose: "speaker" });
      return NextResponse.json(
        {
          error: `The organisers already have a speaker profile for ${emailLower}. ${claimLinkNote(sent)}`,
          code: "CONFIRM_EMAIL_TO_CLAIM",
        },
        { status: 409 },
      );
    }

    let speakerId: string | null = null;
    await tenantTransaction(async (tx) => {
      if (becomesSubmitter) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            role: "SUBMITTER",
            ...(!user.termsAcceptedAt && { termsAcceptedAt: new Date(), termsAcceptedIp: ip }),
          },
        });
      }

      // Ensure the speaker exists and is linked to this user. With confirmed
      // details the person just reviewed their profile, so refresh it like the
      // new-account door does (a name already on file stays locked); without
      // them, never clobber an existing profile.
      speakerId = await upsertEventSpeaker(tx, {
        eventId: event.id,
        organizationId: event.organizationId,
        email: emailLower,
        userId: user.id,
        overwriteExisting: Boolean(d),
        accountConfirmed: !!scope?.confirmed,
        profile: {
          firstName,
          lastName,
          ...profile,
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
    if (!speakerId) {
      // This event's speaker record is the organisers' and unclaimed: the
      // account takes it over once it confirms the address (upsertEventSpeaker).
      apiLogger.info({ msg: "public/abstract-start:speaker-claim-needs-confirmation", eventId: event.id });
      const sent = await sendEmailVerification({ organizationId: event.organizationId, email: emailLower, name: `${firstName} ${lastName}`, purpose: "speaker" });
      return NextResponse.json(
        {
          error: `The organisers already have a speaker profile for ${emailLower}. ${claimLinkNote(sent)}`,
          code: "CONFIRM_EMAIL_TO_CLAIM",
        },
        { status: 409 },
      );
    }

    await ensureSubmitterRegistration({
      speaker: {
        id: speakerId,
        eventId: event.id,
        email: emailLower,
        firstName,
        lastName,
        title: profile.title,
        role: profile.role,
        additionalEmail: profile.additionalEmail,
        organization: profile.organization,
        jobTitle: profile.jobTitle,
        phone: profile.phone,
        city: profile.city,
        state: profile.state,
        zipCode: profile.zipCode,
        country: profile.country,
        specialty: profile.specialty,
      },
      organizationId: event.organizationId,
      eventSettings: event.settings,
      source: parsed.data.source,
      ticketTypeId: parsed.data.ticketTypeId ?? null,
      evidence: parsed.data,
      // The rate the person chose on the details page (Sep 29, 2026). Where the
      // event charges presenters it is required above; where it charges
      // nothing they get the complimentary companion (D4) or keep the
      // registration they already hold.
      expectedLink: null,
      requestIp: getClientIp(req),
    });

    apiLogger.info({ msg: "public/abstract-start:ready", eventId: event.id, email: emailLower, becameSubmitter: becomesSubmitter });
    return NextResponse.json({ ok: true, eventId: event.id, becameSubmitter: becomesSubmitter });
    });
  } catch (error) {
    if (error instanceof SpeakerLinkedElsewhereError) {
      apiLogger.warn({ msg: "public/abstract-start:speaker-linked-to-other-account" });
      return NextResponse.json(
        { error: "This speaker profile belongs to another account. Sign in with that account, or contact the organisers.", code: "SPEAKER_LINKED_TO_OTHER_ACCOUNT" },
        { status: 409 }
      );
    }
    apiLogger.error({ err: error, msg: "abstract-start failed" });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

/** What to say about the confirmation link, truthfully. */
function claimLinkNote(sent: "sent" | "rate-limited" | "failed"): string {
  if (sent === "sent") return "We sent a link to that address: sign in, then open it to take the profile over.";
  if (sent === "rate-limited") return "We sent links to that address recently: sign in, then open the latest one to take the profile over.";
  return "We could not send the link just now. Please try again shortly.";
}
