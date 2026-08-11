/**
 * What an abstract signup does about the submitter's registration
 * (Aug 11, 2026). See docs/PRESENTER_REGISTRATION_PLAN.md.
 *
 * Both abstract doors (`/submitter` for a new account, `/abstract-start` for
 * someone signing in with an existing one) ask the same question, so they ask
 * it here rather than each deciding for itself.
 *
 * THE RULE:
 *   proposal signup                    -> link only, never create (Aug 5)
 *   abstract, event HAS presenter rates -> a REAL payable registration
 *   abstract, event has none            -> the complimentary Faculty companion,
 *                                          exactly as before (plan D4)
 *
 * That last branch is what makes this safe to deploy: every existing event has
 * no presenter rates, so every existing event keeps its current behaviour until
 * an organizer sets some.
 *
 * FAILURE-ISOLATED BY CONTRACT. The account and the speaker row are already
 * committed by the time this runs, and a registration hiccup must never fail a
 * signup: the person would be left unable to sign in, with no way to retry. So
 * everything here is caught, logged, and swallowed, and the organizer can put
 * it right from the Grant registration button.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  ensureSpeakerCompanionRegistration,
  type CompanionSpeakerInput,
} from "@/lib/speaker-companion";
import { createAndLinkPayableRegistration } from "@/lib/presenter-registration";
import { isPresenterPayNowEnabled } from "@/lib/presenter-registration-settings";
import { presenterRateOptions } from "@/lib/presenter-tiers";

export interface PresenterSignupInput {
  speaker: CompanionSpeakerInput;
  organizationId: string;
  /** Settings JSON of the event, for the Pay Now toggle. */
  eventSettings: unknown;
  /** "abstract" | "proposal". Proposals never create a registration. */
  source: string;
  /** The registration type the submitter chose, if the form offered any. */
  ticketTypeId?: string | null;
  /** The RAW pointer as read, for the conditional link claim. */
  expectedLink: string | null;
  requestIp?: string | null;
}

/**
 * Resolve the presenter tier for a chosen registration type SERVER-side.
 * The client sends only a type id: the tier and the price are never taken from
 * the browser, and sharing `presenterRateOptions` with the form is what keeps
 * the rate a submitter was shown identical to the one they are charged.
 *
 * Returns null when this event offers no presenter rates, or the chosen type
 * has none open, which routes to the D4 comp fallback.
 */
export async function resolvePresenterRate(
  eventId: string,
  ticketTypeId: string | null | undefined,
): Promise<{ ticketTypeId: string; pricingTierId: string } | null> {
  if (!ticketTypeId) return null;
  const ticketTypes = await db.ticketType.findMany({
    where: { eventId, isActive: true, isFaculty: false },
    select: {
      id: true,
      name: true,
      isActive: true,
      pricingTiers: {
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          price: true,
          currency: true,
          sortOrder: true,
          quantity: true,
          soldCount: true,
          salesStart: true,
          salesEnd: true,
        },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  const now = Date.now();
  const options = presenterRateOptions(
    ticketTypes.map((tt) => ({
      id: tt.id,
      name: tt.name,
      isActive: tt.isActive,
      pricingTiers: tt.pricingTiers.map((t) => ({
        id: t.id,
        name: t.name,
        price: Number(t.price),
        currency: t.currency,
        sortOrder: t.sortOrder,
        // `canPurchase` is computed by the public API for the form; recompute
        // it here from the same facts so a tier that closed between page load
        // and submit is not sold anyway.
        canPurchase:
          t.soldCount < t.quantity &&
          (!t.salesStart || new Date(t.salesStart).getTime() <= now) &&
          (!t.salesEnd || new Date(t.salesEnd).getTime() >= now),
      })),
    })),
  );
  const chosen = options.find((o) => o.ticketTypeId === ticketTypeId);
  return chosen ? { ticketTypeId: chosen.ticketTypeId, pricingTierId: chosen.tierId } : null;
}

/**
 * Give the submitter whatever registration this event's configuration calls
 * for. Never throws.
 */
export async function ensureSubmitterRegistration(input: PresenterSignupInput): Promise<void> {
  const { speaker, source, expectedLink } = input;
  try {
    // Session proposals create nothing (Aug 5). Steps 1-2 of the helper still
    // run, so a proposer who registered themselves gets that row linked.
    if (source === "proposal") {
      await ensureSpeakerCompanionRegistration(speaker, { linkOnly: true, expectedLink });
      return;
    }

    const rate = await resolvePresenterRate(speaker.eventId, input.ticketTypeId);
    if (!rate) {
      // D4: this event has no presenter rates (or the chosen one closed).
      // Behave exactly as before.
      await ensureSpeakerCompanionRegistration(speaker, { expectedLink });
      return;
    }

    const outcome = await createAndLinkPayableRegistration({
      eventId: speaker.eventId,
      organizationId: input.organizationId,
      speaker: {
        id: speaker.id,
        email: speaker.email,
        firstName: speaker.firstName,
        lastName: speaker.lastName,
        title: speaker.title ?? null,
        role: speaker.role ?? null,
        additionalEmail: speaker.additionalEmail ?? null,
        organization: speaker.organization ?? null,
        jobTitle: speaker.jobTitle ?? null,
        phone: speaker.phone ?? null,
        photo: null,
        city: speaker.city ?? null,
        state: speaker.state ?? null,
        zipCode: speaker.zipCode ?? null,
        country: speaker.country ?? null,
        specialty: speaker.specialty ?? null,
        sourceRegistrationId: expectedLink,
      },
      ticketTypeId: rate.ticketTypeId,
      pricingTierId: rate.pricingTierId,
      requestIp: input.requestIp ?? null,
      source: "api",
      // A public door, so the sales window applies. Only an organizer grant
      // overrides it.
      overrideSalesWindow: false,
      // D3: quote yes, Pay Now only if the organizer turned it on.
      suppressPayNow: !isPresenterPayNowEnabled(input.eventSettings),
      logPrefix: "presenter-signup",
    });

    // A rejection here is not fatal to the signup. The account exists, the
    // speaker exists, and the organizer can grant a registration by hand; a
    // hard failure would instead leave someone unable to sign in at all.
    if (outcome.status === "rejected") {
      apiLogger.warn({
        msg: "presenter-signup:registration-refused",
        eventId: speaker.eventId,
        speakerId: speaker.id,
        code: outcome.code,
        detail: outcome.message,
      });
    }
  } catch (err) {
    apiLogger.error(
      { err, speakerId: speaker.id, eventId: speaker.eventId },
      "presenter-signup:failed",
    );
  }
}
