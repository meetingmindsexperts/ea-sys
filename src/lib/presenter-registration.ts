/**
 * Mint a PAYABLE registration for a speaker and link it as their attendee
 * facet (Aug 11, 2026). See docs/PRESENTER_REGISTRATION_PLAN.md.
 *
 * WHY THIS IS A MODULE. This operation was written inside the grant-companion
 * route for the Aug 5 payable grant. The presenter-registration work adds two
 * more callers (the abstract signup door and its sign-in sibling), which makes
 * three, and a domain operation called from more than one entry point belongs
 * in one place. The interesting part is not the create, which the registration
 * service already owns, but the LINK: it is a conditional claim with a
 * compensating cancel, and getting that subtly different in three copies is
 * how someone ends up holding two live registrations.
 *
 * WHAT IT DOES, in order:
 *   1. `createRegistration` (the service owns seat claim, payment-status
 *      defaulting, the confirmation email and the quote PDF).
 *   2. If the service reports ALREADY_REGISTERED, that person holds a live
 *      registration already: link THAT instead of failing, so nobody is
 *      double-registered.
 *   3. Otherwise claim the speaker's `sourceRegistrationId` CONDITIONALLY on
 *      the pointer the caller read. Losing that race means we just minted a
 *      duplicate whose confirmation email may already be out, so the duplicate
 *      is cancelled rather than left live.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: audit rows and HTTP mapping. Those differ
 * per caller (an organizer grant is attributed to a user and audited as
 * COMPANION_GRANTED; a public self-signup is neither), so the result is
 * errors-as-values and each caller shapes its own response.
 */
import type { RegistrationCreatedSource } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  createRegistration,
  type RegistrationAttendeeRole,
  type RegistrationTitle,
} from "@/services/registration-service";
import { cancelRegistration } from "@/services/payment-service";

/** The speaker fields the attendee row is built from. */
export interface PayableFacetSpeaker {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  title: string | null;
  role: string | null;
  additionalEmail: string | null;
  organization: string | null;
  jobTitle: string | null;
  phone: string | null;
  photo: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
  specialty: string | null;
  /**
   * The RAW pointer as the caller read it, which may be a CANCELLED
   * registration's id on a re-grant. The link claim asserts this value, so two
   * concurrent callers reading the same pointer cannot both commit.
   */
  sourceRegistrationId: string | null;
}

export type PayableFacetResult =
  /** A new registration was created and linked. */
  | {
      status: "created";
      registrationId: string;
      registrationStatus: string;
      paymentStatus: string;
    }
  /** They already held a live registration; that one is now the facet. */
  | {
      status: "linked-existing";
      registrationId: string;
      registrationStatus: string | null;
      paymentStatus: string | null;
    }
  /** Someone else linked first. The duplicate we minted was cancelled. */
  | { status: "race-lost"; duplicateRegistrationId: string; compensated: boolean }
  /** The service refused (sold out, bad tier, faculty type, ...). */
  | { status: "rejected"; code: string; message: string };

export interface CreateAndLinkPayableInput {
  eventId: string;
  organizationId: string;
  speaker: PayableFacetSpeaker;
  ticketTypeId: string;
  pricingTierId: string | null;
  /** Audit attribution. Null for a public self-signup. */
  actorUserId?: string | null;
  actorFirstName?: string | null;
  requestIp?: string | null;
  source: "rest" | "api";
  /**
   * Skip the ticket type's PUBLIC sales window. True for an organizer grant
   * (review happens after public sales close); FALSE for a public door, where
   * the window is the whole point of a sales window.
   */
  overrideSalesWindow?: boolean;
  /**
   * Suppress the Pay Now call to action on the confirmation while still
   * attaching the quote (plan D3). The registrant portal keeps its own.
   */
  suppressPayNow?: boolean;
  /**
   * Skip the delegate registration-confirmation email because this caller
   * sends its own. See the field of the same name on the service input.
   */
  suppressConfirmationEmail?: boolean;
  /**
   * Entry path to stamp on the row. Omit for an organizer grant (the service
   * derives ADMIN_DASHBOARD, which is what a grant is). The PUBLIC abstract
   * door MUST pass PUBLIC_SUBMITTER — it is what routes a tier-priced row to
   * the TIER's seat counter rather than the ticket type's, see `seatCounter`.
   */
  createdSource?: RegistrationCreatedSource;
  /** Prefix for this caller's log lines, e.g. "grant-companion". */
  logPrefix: string;
}

export async function createAndLinkPayableRegistration(
  input: CreateAndLinkPayableInput,
): Promise<PayableFacetResult> {
  const { eventId, organizationId, speaker, logPrefix } = input;

  const created = await createRegistration({
    eventId,
    organizationId,
    userId: input.actorUserId ?? "",
    ticketTypeId: input.ticketTypeId,
    pricingTierId: input.pricingTierId,
    attendee: {
      // Speaker's Title/AttendeeRole enums are value-identical to the
      // service's narrowed string unions.
      title: (speaker.title as RegistrationTitle | null) ?? null,
      role: (speaker.role as RegistrationAttendeeRole | null) ?? null,
      email: speaker.email,
      additionalEmail: speaker.additionalEmail,
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      organization: speaker.organization,
      jobTitle: speaker.jobTitle,
      phone: speaker.phone,
      photo: speaker.photo,
      city: speaker.city,
      state: speaker.state,
      zipCode: speaker.zipCode,
      country: speaker.country,
      specialty: speaker.specialty,
    },
    source: input.source,
    requestIp: input.requestIp ?? undefined,
    actorFirstName: input.actorFirstName ?? null,
    overrideSalesWindow: input.overrideSalesWindow,
    suppressPayNow: input.suppressPayNow,
    suppressConfirmationEmail: input.suppressConfirmationEmail,
    createdSource: input.createdSource,
  });

  if (!created.ok) {
    // Same-email registration already exists → link it as the facet instead of
    // failing. The service's dup check excludes CANCELLED, so the row is live.
    const existingId =
      created.code === "ALREADY_REGISTERED"
        ? (created.meta?.existingRegistrationId as string | undefined)
        : undefined;
    if (!existingId) {
      apiLogger.warn({
        msg: `${logPrefix}:payable-rejected`,
        eventId,
        speakerId: speaker.id,
        code: created.code,
        detail: created.message,
      });
      return { status: "rejected", code: created.code, message: created.message };
    }

    // Conditional on the pointer we read. A concurrent caller that got there
    // first simply wins: both outcomes are links, so this is benign.
    const linkClaim = await db.speaker.updateMany({
      where: { id: speaker.id, sourceRegistrationId: speaker.sourceRegistrationId },
      data: { sourceRegistrationId: existingId },
    });
    const finalId =
      linkClaim.count > 0
        ? existingId
        : ((
            await db.speaker.findUnique({
              where: { id: speaker.id },
              select: { sourceRegistrationId: true },
            })
          )?.sourceRegistrationId ?? existingId);

    // Return the linked row's REAL state (review H1): it may be a PAID
    // delegate registration, and no caller may fabricate COMPLIMENTARY.
    const linkedRow = await db.registration.findFirst({
      where: { id: finalId, eventId },
      select: { status: true, paymentStatus: true },
    });
    apiLogger.info({
      msg: `${logPrefix}:linked-existing-payable`,
      eventId,
      speakerId: speaker.id,
      registrationId: finalId,
    });
    return {
      status: "linked-existing",
      registrationId: finalId,
      registrationStatus: linkedRow?.status ?? null,
      paymentStatus: linkedRow?.paymentStatus ?? null,
    };
  }

  // CONDITIONAL claim on the pointer we validated (review H2): if a concurrent
  // caller linked something else meanwhile, we just minted a DUPLICATE
  // registration whose confirmation email may already be out. Compensate by
  // cancelling it so nobody holds two live registrations. A CRASH between the
  // create above and this claim is self-healing: the registration exists and is
  // visible in the list, and a retry hits the service's ALREADY_REGISTERED and
  // links it, with no duplicate email.
  const claim = await db.speaker.updateMany({
    where: { id: speaker.id, sourceRegistrationId: speaker.sourceRegistrationId },
    data: { sourceRegistrationId: created.registration.id },
  });
  if (claim.count === 0) {
    apiLogger.error({
      msg: `${logPrefix}:payable-race-lost`,
      eventId,
      speakerId: speaker.id,
      duplicateRegistrationId: created.registration.id,
      userId: input.actorUserId ?? null,
    });
    const compensated = await cancelRegistration({
      registrationId: created.registration.id,
      eventId,
      organizationId,
      refund: false,
      source: input.source,
      issuedByUserId: input.actorUserId ?? undefined,
    });
    if (!compensated.ok) {
      apiLogger.error({
        msg: `${logPrefix}:race-compensation-failed`,
        eventId,
        speakerId: speaker.id,
        registrationId: created.registration.id,
        code: compensated.code,
      });
    }
    return {
      status: "race-lost",
      duplicateRegistrationId: created.registration.id,
      compensated: compensated.ok,
    };
  }

  apiLogger.info({
    msg: `${logPrefix}:payable-created`,
    eventId,
    speakerId: speaker.id,
    registrationId: created.registration.id,
    paymentStatus: created.registration.paymentStatus,
    userId: input.actorUserId ?? null,
  });
  return {
    status: "created",
    registrationId: created.registration.id,
    // Real state (review H1): a requiresApproval type creates PENDING, not
    // CONFIRMED, and the caller renders what actually happened.
    registrationStatus: created.registration.status,
    paymentStatus: created.registration.paymentStatus,
  };
}
