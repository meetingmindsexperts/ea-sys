/**
 * Speaker companion registration — the "attendee facet" of a speaker.
 *
 * A speaker added by the organizer must receive everything a registration
 * receives (badge, entry barcode, DTCM barcode, check-in, survey). Rather than
 * duplicating all of that onto the Speaker entity, we give the speaker a
 * companion Registration backed by an auto-provisioned, hidden "Faculty" ticket
 * type that is comp + uncapped (so faculty never consume a paid seat or revenue).
 *
 * The link reuses `Speaker.sourceRegistrationId` (the same column the import
 * path and the activity timeline already use).
 */
import { db, tenantTransaction } from "@/lib/db";
import { lockRegistrationEmails } from "@/lib/registration-email-lock";
import { apiLogger } from "@/lib/logger";
import { generateBarcode } from "@/lib/utils";
import { ensureEntryBarcode } from "@/lib/entry-barcode-mint";
import { getNextSerialId } from "@/lib/registration-serial";
import { completedAtOnCreate } from "@/lib/registration-completion";
import { Prisma, type Title, type AttendeeRole, type SpeakerStatus } from "@prisma/client";

/** The speakers' type's name when an ordinary "Faculty" already exists and cannot be adopted. */
export const SPEAKER_FACULTY_FALLBACK_NAME = "Faculty (speakers)";

/** Payment states that mean money was taken, owed or covered: a type holding any is never adopted. */
const MONEY_PAYMENT_STATUSES = ["PAID", "PENDING", "REFUNDED", "FAILED", "INCLUSIVE"] as const;

/**
 * An ordinary "Faculty" type the speakers' type may take over, or null.
 *
 * Usually a leftover from cloning before Jul 27, 2026, when the clone dropped
 * `isFaculty` and the hidden type came back as an ordinary one. Adopting it
 * hides it from public registration and stops its registrations counting as
 * delegates, so it is only done when the type is free (type, virtual and every
 * tier at 0) and no registration on it carries money.
 */
async function adoptableFacultyType(eventId: string): Promise<{ id: string } | { blocked: string } | null> {
  const leftover = await db.ticketType.findFirst({
    where: { eventId, isFaculty: false, name: { equals: "Faculty", mode: "insensitive" } },
    select: {
      id: true,
      price: true,
      virtualPrice: true,
      pricingTiers: { where: { price: { gt: 0 } }, select: { id: true }, take: 1 },
      _count: { select: { registrations: { where: { paymentStatus: { in: [...MONEY_PAYMENT_STATUSES] } } } } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!leftover) return null;
  const priced = Number(leftover.price) > 0 || Number(leftover.virtualPrice ?? 0) > 0 || leftover.pricingTiers.length > 0;
  if (priced) return { blocked: "priced" };
  if (leftover._count.registrations > 0) return { blocked: "paid-registrations" };
  return { id: leftover.id };
}

/**
 * Find-or-create the event's hidden Faculty ticket type. Comp (price 0),
 * uncapped, `isFaculty: true` (excluded from public registration + paid
 * capacity). Rare concurrent duplicates are harmless — companions just use one.
 *
 * Never a second type called "Faculty" (Oct 19, 2026): an ordinary "Faculty"
 * already on the event is adopted when that is safe, and otherwise the new
 * type is named "Faculty (speakers)" so the two can be told apart.
 */
export async function ensureFacultyTicketType(eventId: string): Promise<string> {
  const existing = await db.ticketType.findFirst({
    where: { eventId, isFaculty: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing.id;

  const leftover = await adoptableFacultyType(eventId);
  if (leftover && "id" in leftover) {
    // Guarded on isFaculty:false so a concurrent adopt is a no-op, not a second write.
    await db.ticketType.updateMany({ where: { id: leftover.id, isFaculty: false }, data: { isFaculty: true } });
    apiLogger.info({ msg: "speaker-companion:faculty-type-adopted", eventId, ticketTypeId: leftover.id });
    return leftover.id;
  }

  // Denormalized tenant key for the Faculty type (ticketing sweep). Derived
  // from the event; this create fires once per event, so the extra PK lookup
  // is negligible.
  const ev = await db.event.findUnique({
    where: { id: eventId },
    select: { organizationId: true },
  });

  const name = leftover ? SPEAKER_FACULTY_FALLBACK_NAME : "Faculty";
  const created = await db.ticketType.create({
    data: {
      eventId,
      organizationId: ev?.organizationId ?? null,
      name,
      category: "Faculty",
      isFaculty: true,
      isActive: true,
      isDefault: false,
      price: 0,
      quantity: 999999,
    },
    select: { id: true },
  });
  apiLogger.info({
    msg: "speaker-companion:faculty-type-created",
    eventId,
    ticketTypeId: created.id,
    name,
    ...(leftover ? { leftoverNotAdopted: leftover.blocked } : {}),
  });
  return created.id;
}

export interface CompanionSpeakerInput {
  id: string;
  eventId: string;
  email: string;
  firstName: string;
  lastName: string;
  title?: Title | null;
  additionalEmail?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  photo?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  specialty?: string | null;
  /**
   * The speaker's professional category (Physician / Allied Health / Nurse /
   * Others). Stored on the companion attendee's `registrationType`. NOTE: this
   * is NOT "Faculty" — Faculty is a badge/role (`badgeType`), not a profession.
   * Left null when the speaker's category wasn't recorded.
   */
  registrationType?: string | null;
  /** The speaker's `role` (AttendeeRole profession category, e.g. PHYSICIAN).
   *  Copied onto the companion attendee so the "Role" surfaces the same value. */
  role?: AttendeeRole | null;
  sourceRegistrationId?: string | null;
}

/** A registration the speaker already holds, as the link step needs it. */
type ExistingRegistration = Prisma.RegistrationGetPayload<{ select: { id: true; qrCode: true; attendanceMode: true } }>;

/** The person registered while the companion was being made: link theirs instead. */
class CompanionFoundRegistration extends Error {
  constructor(public readonly registration: ExistingRegistration) {
    super("COMPANION_FOUND_REGISTRATION");
    this.name = "CompanionFoundRegistration";
  }
}

/** Thrown inside the create tx when the conditional link claim matches 0 rows
 *  (a concurrent grant won) — rolls the whole create back. Internal. */
class CompanionLinkRaceError extends Error {
  constructor() {
    super("companion link race lost");
    this.name = "CompanionLinkRaceError";
  }
}

export type CompanionResult =
  | { status: "already-linked"; registrationId: string }
  | { status: "linked-by-email"; registrationId: string }
  | { status: "created"; registrationId: string }
  | { status: "link-only-no-create"; registrationId: null };

/**
 * Link the speaker to a registration they already hold (never duplicate a real
 * registrant). Shared by the read before the create and the re-check inside it.
 */
async function linkExistingRegistration(
  speaker: CompanionSpeakerInput,
  existing: ExistingRegistration,
): Promise<CompanionResult> {
  await db.speaker.update({
    where: { id: speaker.id },
    data: { sourceRegistrationId: existing.id },
  });
  // The speaker's badge and check-in use this registration's barcode. One
  // made by a path that minted none (Import from Contacts, before Oct 19,
  // 2026) gets one now; guarded on qrCode: null, so none is ever replaced.
  // Failure-isolated (review of 35eb4e35, L2): the link above is already
  // made, so a failed mint must not report the speaker as failed. The
  // backfill script recovers it.
  try {
    await ensureEntryBarcode(existing, "speaker-linked");
  } catch (err) {
    apiLogger.error({ err, msg: "speaker-companion:barcode-mint-failed", speakerId: speaker.id, registrationId: existing.id });
  }
  apiLogger.info({
    msg: "speaker-companion:linked-existing",
    speakerId: speaker.id,
    eventId: speaker.eventId,
    registrationId: existing.id,
  });
  return { status: "linked-by-email", registrationId: existing.id };
}

/**
 * Ensure the speaker has a companion registration, idempotently:
 *   1. already linked (`sourceRegistrationId`)        → no-op
 *   2. a registration with the same email exists      → link it (never duplicate
 *                                                        a real registrant)
 *   3. otherwise                                      → create a Faculty companion
 *
 * Callers should treat this as failure-isolated (the speaker create must succeed
 * even if this hiccups — the backfill script recovers any that fail).
 */
export async function ensureSpeakerCompanionRegistration(
  speaker: CompanionSpeakerInput,
  /**
   * `linkOnly: true` skips the create step (owner decision Aug 5, 2026 —
   * SESSION-PROPOSAL signups must NOT auto-mint a complimentary registration:
   * most proposers are invited faculty, some must register and pay, some get
   * comped — the organizer decides per person via the Grant-registration
   * dialog, comp or payable). Steps 1–2 still run so a proposer who already
   * registered themselves gets their real registration linked.
   */
  opts?: {
    linkOnly?: boolean;
    /**
     * The speaker row's RAW current `sourceRegistrationId` as the caller read
     * it (may be a CANCELLED registration's id on a re-grant, while
     * `speaker.sourceRegistrationId` is passed as null to bypass step 1).
     * The create step's link is a CONDITIONAL claim on this value (review H2,
     * Aug 5 2026): two concurrent grants both reading the same pointer can't
     * both commit — the loser's whole transaction (attendee + registration +
     * serial) rolls back and the winner's registration is returned. Defaults
     * to `speaker.sourceRegistrationId ?? null`.
     */
    expectedLink?: string | null;
  },
): Promise<CompanionResult> {
  if (speaker.sourceRegistrationId) {
    return { status: "already-linked", registrationId: speaker.sourceRegistrationId };
  }

  if (speaker.email) {
    // Never link a CANCELLED registration as the attendee facet — check-in
    // hard-rejects cancelled rows, so the link would hand the speaker a dead
    // badge/barcode permanently (the sourceRegistrationId short-circuit above
    // makes the first link sticky). A registered-then-cancelled person who is
    // later added as faculty falls through to a fresh Faculty companion.
    const existing = await db.registration.findFirst({
      where: {
        eventId: speaker.eventId,
        // Case-insensitive (review LOW, Aug 5 2026): a legacy mixed-case
        // speaker email must still match its lowercased attendee row —
        // an exact-match miss here would mint a DUPLICATE Faculty companion
        // for someone who already holds a real registration.
        attendee: { email: { equals: speaker.email, mode: "insensitive" } },
        status: { not: "CANCELLED" },
      },
      select: { id: true, qrCode: true, attendanceMode: true },
      orderBy: { createdAt: "asc" },
    });
    if (existing) return linkExistingRegistration(speaker, existing);
  }

  if (opts?.linkOnly) {
    apiLogger.info({
      msg: "speaker-companion:link-only-skip-create",
      speakerId: speaker.id,
      eventId: speaker.eventId,
    });
    return { status: "link-only-no-create", registrationId: null };
  }

  // The pointer value the conditional claim below asserts (see opts docs).
  const expectedLink =
    opts?.expectedLink !== undefined ? opts.expectedLink : (speaker.sourceRegistrationId ?? null);

  const facultyTypeId = await ensureFacultyTicketType(speaker.eventId);
  // Tenant stamp for the companion attendee/registration rows — the input
  // carries only the eventId, so resolve the event's org here (create path
  // only; runs once per speaker add).
  const { organizationId } = await db.event.findUniqueOrThrow({
    where: { id: speaker.eventId },
    select: { organizationId: true },
  });
  const qrCode = generateBarcode();

  const registrationId = await tenantTransaction(async (tx) => {
    // The read above is a fast path; behind the per-person lock, a registration
    // a concurrent request just made is seen and linked instead of a second
    // one being created (src/lib/registration-email-lock.ts).
    if (speaker.email) {
      await lockRegistrationEmails(tx, speaker.eventId, [speaker.email]);
      const raced = await tx.registration.findFirst({
        where: {
          eventId: speaker.eventId,
          attendee: { email: { equals: speaker.email, mode: "insensitive" } },
          status: { not: "CANCELLED" },
        },
        select: { id: true, qrCode: true, attendanceMode: true },
        orderBy: { createdAt: "asc" },
      });
      if (raced) throw new CompanionFoundRegistration(raced);
    }
    const serialId = await getNextSerialId(tx, speaker.eventId, organizationId);
    const attendee = await tx.attendee.create({
      data: {
        organizationId,
        email: speaker.email,
        firstName: speaker.firstName,
        lastName: speaker.lastName,
        title: speaker.title ?? undefined,
        additionalEmail: speaker.additionalEmail ?? undefined,
        organization: speaker.organization ?? undefined,
        jobTitle: speaker.jobTitle ?? undefined,
        phone: speaker.phone ?? undefined,
        photo: speaker.photo ?? undefined,
        city: speaker.city ?? undefined,
        state: speaker.state ?? undefined,
        zipCode: speaker.zipCode ?? undefined,
        country: speaker.country ?? undefined,
        specialty: speaker.specialty ?? undefined,
        // The professional category (Physician/Nurse/…), NOT "Faculty" — the
        // Faculty designation lives in `badgeType` + the isFaculty ticket type.
        registrationType: speaker.registrationType ?? undefined,
        // Role (AttendeeRole) carried over from the speaker so the companion
        // registration's Role matches the speaker's.
        role: speaker.role ?? undefined,
      },
      select: { id: true },
    });
    const reg = await tx.registration.create({
      data: {
        organizationId,
        eventId: speaker.eventId,
        attendeeId: attendee.id,
        ticketTypeId: facultyTypeId,
        // Faculty: confirmed, comp, in-person, entry barcode minted. NO
        // soldCount increment — the Faculty type is uncapped/isFaculty.
        status: "CONFIRMED",
        paymentStatus: "COMPLIMENTARY",
        attendanceMode: "IN_PERSON",
        qrCode,
        serialId,
        badgeType: "Faculty",
        createdSource: "SPEAKER_COMPANION",
        completedAt: completedAtOnCreate("SPEAKER_COMPANION"),
        // Faculty companion is comp (price 0) — stamp it so the read surfaces
        // treat it as a $0 registration, not an unresolved one.
        originalPrice: 0,
      },
      select: { id: true },
    });
    // CONDITIONAL claim on the link (review H2, Aug 5 2026): the pointer must
    // still be what the caller read (null, or the cancelled id on a re-grant).
    // Under READ COMMITTED the loser of two concurrent grants blocks on the
    // winner's row lock, re-evaluates the predicate after commit, matches 0
    // rows, and this throw rolls back its attendee + registration + serial —
    // one person can never end up with two live companions.
    const claim = await tx.speaker.updateMany({
      where: { id: speaker.id, sourceRegistrationId: expectedLink },
      data: { sourceRegistrationId: reg.id },
    });
    if (claim.count === 0) throw new CompanionLinkRaceError();
    return reg.id;
  }).catch(async (err) => {
    if (err instanceof CompanionFoundRegistration) return { kind: "found" as const, registration: err.registration };
    if (!(err instanceof CompanionLinkRaceError)) throw err;
    // Lost the race — the winner's registration is the companion now. Our
    // attendee/registration/serial all rolled back with the transaction.
    const current = await db.speaker.findUnique({
      where: { id: speaker.id },
      select: { sourceRegistrationId: true },
    });
    apiLogger.warn({
      msg: "speaker-companion:link-race-lost",
      speakerId: speaker.id,
      eventId: speaker.eventId,
      winnerRegistrationId: current?.sourceRegistrationId ?? null,
    });
    if (!current?.sourceRegistrationId) throw err; // pointer vanished — surface it
    return { kind: "race-lost" as const, winnerId: current.sourceRegistrationId };
  });

  if (typeof registrationId === "object" && registrationId.kind === "found") {
    const found = registrationId.registration;
    apiLogger.info({ msg: "speaker-companion:found-existing-in-tx", speakerId: speaker.id, eventId: speaker.eventId, registrationId: found.id });
    // A concurrent grant for this same speaker made it and already linked it:
    // that is "already linked", not a second link (and a second audit row in
    // the grant route; review of f74b2017, L3).
    const current = await db.speaker.findUnique({ where: { id: speaker.id }, select: { sourceRegistrationId: true } });
    if (current?.sourceRegistrationId === found.id) return { status: "already-linked", registrationId: found.id };
    return linkExistingRegistration(speaker, found);
  }
  if (typeof registrationId === "object") {
    return { status: "already-linked", registrationId: registrationId.winnerId };
  }

  apiLogger.info({
    msg: "speaker-companion:created",
    speakerId: speaker.id,
    eventId: speaker.eventId,
    registrationId,
  });
  return { status: "created", registrationId };
}

/**
 * Batch companion ensure for the bulk speaker-add paths (CSV import,
 * import-contacts, MCP bulk). Resolves speakers by email within the event,
 * skipping those already linked, and ensures a companion for each — per-item
 * failure-isolated so one bad row can't break the rest. Returns a summary.
 *
 * Awaited by callers (correct + the backfill script recovers any failures). For
 * very large speaker imports a worker-side reconciler is the scale follow-up.
 */
export async function ensureCompanionsForSpeakerEmails(
  eventId: string,
  emails: string[],
): Promise<{ created: number; linked: number; failed: number }> {
  const summary = { created: 0, linked: 0, failed: 0 };
  if (emails.length === 0) return summary;

  const speakers = await db.speaker.findMany({
    where: { eventId, email: { in: emails }, sourceRegistrationId: null },
    select: {
      id: true,
      eventId: true,
      email: true,
      firstName: true,
      lastName: true,
      title: true,
      additionalEmail: true,
      organization: true,
      jobTitle: true,
      phone: true,
      photo: true,
      city: true,
      state: true,
      zipCode: true,
      country: true,
      specialty: true,
      registrationType: true,
      role: true,
      sourceRegistrationId: true,
    },
  });

  for (const spk of speakers) {
    try {
      const res = await ensureSpeakerCompanionRegistration(spk);
      if (res.status === "created") summary.created++;
      else if (res.status === "linked-by-email") summary.linked++;
    } catch (err) {
      summary.failed++;
      apiLogger.error({ err, speakerId: spk.id, eventId }, "speaker-companion:batch-item-failed");
    }
  }
  return summary;
}

/** Profile fields for `upsertEventSpeaker`. Only name is required; the rest are
 *  optional (a Speaker only requires eventId/email/firstName/lastName). */
export interface EventSpeakerProfile {
  firstName: string;
  lastName: string;
  title?: Title | null;
  role?: AttendeeRole | null;
  additionalEmail?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  specialty?: string | null;
  customSpecialty?: string | null;
  registrationType?: string | null;
  /** Only applied on CREATE (links the speaker to an existing registration). */
  sourceRegistrationId?: string | null;
  /**
   * Speaker status for a NEWLY-CREATED speaker only — an EXISTING speaker's
   * status is NEVER touched by the upsert (an invited/confirmed speaker who
   * signs in keeps the status the organizer set — inheritance, owner decision
   * Aug 5, 2026). BOTH self-signup doors (abstract + proposal) pass "INVITED":
   * a fresh self-signup is NOT a confirmed speaker — the team reviews the
   * submission and flips the status by hand. If "Invited" proves confusing
   * for uninvited people, Option B is a dedicated PENDING enum value
   * (additive migration + label maps + MCP whitelists). Defaults to CONFIRMED
   * for any future caller that doesn't specify.
   */
  status?: SpeakerStatus;
  /**
   * Which self-signup flow this upsert comes from ("abstract" | "proposal").
   * Each door GRANTS its surface and never removes the other — a person who
   * has used both doors is stamped "both" (owner decision Aug 4, 2026: the
   * two registers are independent; someone can submit abstracts AND session
   * proposals, each through its own link). See src/lib/submitter-surfaces.ts.
   */
  submitterSource?: string | null;
}

function submitterSourceStamp(
  existingSource: string | null | undefined,
  incomingSource: string | null | undefined,
): { submitterSource?: string } {
  if (!incomingSource) return {};
  if (existingSource && existingSource !== incomingSource) return { submitterSource: "both" };
  return { submitterSource: incomingSource };
}

/**
 * Find-or-create the Speaker for `(eventId, email)` and link it to `userId`,
 * returning the speaker id. **Transaction-aware** — the caller passes its own
 * `tx` so this runs inside the caller's atomic boundary (the submitter route
 * creates the User + Speaker in ONE transaction).
 *
 * `overwriteExisting`:
 *   - `true`  (sign-UP form) — the user just typed fresh details, so refresh the
 *     existing speaker's profile from `profile`.
 *   - `false` (sign-IN flow) — don't clobber an existing profile; only ensure
 *     the `userId` link so `/abstracts/new` recognises it as "my speaker".
 *
 * Both abstract-onboarding routes (`submitter` + `abstract-start`) shared this
 * ~40-line block verbatim; centralising it removes the Speaker-shape drift risk.
 * (Pair with `ensureSpeakerCompanionRegistration` for the badge/check-in facet.)
 */
export async function upsertEventSpeaker(
  tx: Prisma.TransactionClient,
  args: {
    eventId: string;
    organizationId: string;
    email: string;
    userId: string;
    profile: EventSpeakerProfile;
    overwriteExisting: boolean;
  },
): Promise<string> {
  const { eventId, organizationId, email, userId, profile, overwriteExisting } = args;

  const existing = await tx.speaker.findUnique({
    where: { eventId_email: { eventId, email } },
    select: { id: true, submitterSource: true, firstName: true, lastName: true },
  });

  if (existing) {
    // submitterSource: a door GRANTS its surface, never narrows (Aug 4,
    // 2026) — first door stamps it; using the OTHER door later widens to
    // "both" (the surfaces are independent: a person can submit abstracts
    // AND session proposals, each via its own register link).
    const sourceStamp = submitterSourceStamp(existing.submitterSource, profile.submitterSource);
    await tx.speaker.update({
      where: { id: existing.id },
      // Sign-in flow: only ensure the link. Sign-up flow: refresh the profile
      // from `profile`. Values are passed THROUGH (not `?? null`): Prisma treats
      // `undefined` as "leave unchanged" and `null` as "set null", so the caller
      // controls each field's semantics (e.g. pass `data.state || null` to clear
      // an empty field, or `data.title` to leave it untouched when absent).
      data: overwriteExisting
        ? {
            ...sourceStamp,
            userId,
            title: profile.title,
            role: profile.role,
            // Name lock (Aug 5, 2026, owner rule): a name already on file is
            // never rewritten by a signup door — like My Details, changes go
            // through the organizing team. A blank name may still be filled.
            ...(existing.firstName?.trim() ? {} : { firstName: profile.firstName }),
            ...(existing.lastName?.trim() ? {} : { lastName: profile.lastName }),
            additionalEmail: profile.additionalEmail,
            organization: profile.organization,
            jobTitle: profile.jobTitle,
            phone: profile.phone,
            city: profile.city,
            state: profile.state,
            zipCode: profile.zipCode,
            country: profile.country,
            specialty: profile.specialty,
            customSpecialty: profile.customSpecialty,
            registrationType: profile.registrationType,
          }
        : { ...sourceStamp, userId },
    });
    return existing.id;
  }

  const created = await tx.speaker.create({
    data: {
      eventId,
      organizationId, // multi-tenancy: denormalized org (Speaker sweep)
      userId,
      email,
      title: profile.title ?? null,
      role: profile.role ?? null,
      firstName: profile.firstName,
      lastName: profile.lastName,
      additionalEmail: profile.additionalEmail ?? null,
      organization: profile.organization ?? null,
      jobTitle: profile.jobTitle ?? null,
      phone: profile.phone ?? null,
      city: profile.city ?? null,
      state: profile.state ?? null,
      zipCode: profile.zipCode ?? null,
      country: profile.country ?? null,
      specialty: profile.specialty ?? null,
      customSpecialty: profile.customSpecialty ?? null,
      registrationType: profile.registrationType ?? null,
      sourceRegistrationId: profile.sourceRegistrationId ?? null,
      submitterSource: profile.submitterSource ?? null,
      // CREATE only — see EventSpeakerProfile.status: BOTH self-signup doors
      // pass INVITED (team confirms after review, Aug 5 2026). The CONFIRMED
      // fallback is only for a future caller that doesn't specify; existing
      // speakers keep their status (the update branch never touches it).
      status: profile.status ?? "CONFIRMED",
    },
    select: { id: true },
  });
  return created.id;
}
