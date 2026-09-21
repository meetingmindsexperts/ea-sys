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
import { buildQuotePDFFromRegistration } from "@/lib/quote-pdf";
import { escapeHtml } from "@/lib/html";

/**
 * What the caller needs in order to tell the submitter about their fee.
 * Non-null ONLY when a payable presenter registration was actually created.
 */
export interface PresenterFeeEmailExtras {
  registrationId: string;
  /** Pre-rendered HTML block for `{{presenterFeeBlock}}`. */
  html: string;
  /** Plain-text mirror. */
  text: string;
  /** The quote PDF, ready to attach. Null when it could not be built. */
  attachment: { content: string; name: string } | null;
}

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
  /**
   * The caller will tell the submitter about the fee itself, so the delegate
   * registration-confirmation must NOT be sent (owner decision Aug 11, 2026 —
   * one email, not two). Set this ONLY on a door that has somewhere to put the
   * fee: the `/submitter` door folds it into the welcome email. The
   * `/abstract-start` sign-in door has no welcome, so it leaves this unset and
   * keeps the confirmation, otherwise the quote would silently never arrive.
   */
  callerSendsFeeEmail?: boolean;
}

/**
 * What this event's presenter-rate configuration says about a signup.
 *
 * WHY A UNION AND NOT `| null` (Sep 21, 2026 security review, finding #1).
 *
 * `resolvePresenterRate` used to return null for THREE different situations,
 * and the caller could not tell them apart:
 *
 *   1. the event offers no presenter rates          -> free comp is CORRECT (D4)
 *   2. the event offers rates, none was chosen      -> free comp is a GIVEAWAY
 *   3. the event offers rates, the choice is closed -> free comp is a GIVEAWAY
 *
 * All three collapsed to the D4 comp branch, so omitting one optional field
 * from an unauthenticated POST bought a free COMPLIMENTARY Faculty
 * registration on an event that charges presenters USD 100-125. The rule
 * requiring the field lived only in the browser, and the client comment even
 * claimed it was "Enforced again server-side, since a form can be bypassed" —
 * it was not.
 *
 * Collapsing distinct states into one sentinel is the actual defect; naming
 * them is the fix, and it is what lets the door refuse while the D4 fallback
 * keeps working untouched for every event that charges nothing.
 */
export type PresenterRateSelection =
  /** No presenter rates configured on this event. D4: comp companion. */
  | { kind: "none" }
  /** A rate is on sale and the submitter's choice resolved to it. */
  | { kind: "resolved"; ticketTypeId: string; pricingTierId: string }
  /**
   * This event DOES charge presenters, but no usable rate was chosen — either
   * the field was absent, or it named a type whose presenter tier is closed,
   * sold out or does not exist. Never a comp.
   */
  | { kind: "required"; availableCount: number };

/**
 * Resolve the presenter tier for a chosen registration type SERVER-side.
 * The client sends only a type id: the tier and the price are never taken from
 * the browser, and sharing `presenterRateOptions` with the form is what keeps
 * the rate a submitter was shown identical to the one they are charged.
 */
export async function resolvePresenterRateSelection(
  eventId: string,
  ticketTypeId: string | null | undefined,
): Promise<PresenterRateSelection> {
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
  // Empty is meaningful, not an error: this event charges presenters nothing,
  // so the D4 comp companion is the right outcome and always has been.
  if (options.length === 0) return { kind: "none" };

  // From here the event DOES charge presenters, so a missing or unusable
  // choice is a refusal — never a free registration.
  if (!ticketTypeId) return { kind: "required", availableCount: options.length };

  const chosen = options.find((o) => o.ticketTypeId === ticketTypeId);
  if (!chosen) return { kind: "required", availableCount: options.length };

  return { kind: "resolved", ticketTypeId: chosen.ticketTypeId, pricingTierId: chosen.tierId };
}

/**
 * The door's pre-flight check, shared by BOTH abstract doors (`/submitter`
 * for a new account, `/abstract-start` for an existing one).
 *
 * It exists as its own function because the refusal has to happen BEFORE the
 * account and speaker row are committed. `ensureSubmitterRegistration` runs
 * after that commit and is failure-isolated by contract, so by the time it
 * could notice the problem it is far too late to answer the request with a
 * 400 — it can only decline to create a registration.
 *
 * Returns errors-as-values; the route maps to HTTP, so this file never imports
 * next/server.
 */
export async function checkPresenterRateSelection(
  eventId: string,
  source: string,
  ticketTypeId: string | null | undefined,
): Promise<
  | { ok: true }
  | { ok: false; code: "REGISTRATION_TYPE_REQUIRED"; message: string; availableCount: number }
> {
  // Session proposals create no registration at all (Aug 5), so a presenter
  // rate is not a thing they can or should choose.
  if (source === "proposal") return { ok: true };

  const selection = await resolvePresenterRateSelection(eventId, ticketTypeId);
  if (selection.kind !== "required") return { ok: true };

  return {
    ok: false,
    code: "REGISTRATION_TYPE_REQUIRED",
    message: ticketTypeId
      ? "That registration type is no longer available. Please reload the page and choose again."
      : "Please choose a registration type.",
    availableCount: selection.availableCount,
  };
}

/**
 * Give the submitter whatever registration this event's configuration calls
 * for. Never throws.
 */
export async function ensureSubmitterRegistration(
  input: PresenterSignupInput,
): Promise<PresenterFeeEmailExtras | null> {
  const { speaker, source, expectedLink } = input;
  try {
    // Session proposals create nothing (Aug 5). Steps 1-2 of the helper still
    // run, so a proposer who registered themselves gets that row linked.
    if (source === "proposal") {
      await ensureSpeakerCompanionRegistration(speaker, { linkOnly: true, expectedLink });
      return null;
    }

    const selection = await resolvePresenterRateSelection(speaker.eventId, input.ticketTypeId);

    if (selection.kind === "none") {
      // D4: this event has no presenter rates. Behave exactly as before.
      await ensureSpeakerCompanionRegistration(speaker, { expectedLink });
      return null;
    }

    if (selection.kind === "required") {
      // DEFENCE IN DEPTH. Both doors refuse this before creating an account,
      // so reaching here means either a tier closed in the milliseconds since
      // that check, or a future caller forgot it.
      //
      // The old code minted a free COMPLIMENTARY companion here, which is the
      // giveaway the review found. Linking only is the safe failure: the
      // person keeps their account and can submit, the organizer sees the log
      // and grants the right paid registration from the Grant button. Never
      // hand out a free pass on an event that charges.
      apiLogger.error(
        {
          msg: "presenter-signup:rate-required-but-unresolved",
          eventId: speaker.eventId,
          speakerId: speaker.id,
          chosenTicketTypeId: input.ticketTypeId ?? null,
          availableCount: selection.availableCount,
        },
        "presenter-signup:rate-required-but-unresolved",
      );
      await ensureSpeakerCompanionRegistration(speaker, { linkOnly: true, expectedLink });
      return null;
    }

    const rate = selection;

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
      // Stamp the PUBLIC entry path. Without this the service would derive
      // ADMIN_DASHBOARD from `source: "api"`, and `seatCounter` would burn the
      // ticket TYPE's seat instead of the presenter TIER's — so a presenter
      // tier's seat limit would never fill. Found by running the flow.
      createdSource: "PUBLIC_SUBMITTER",
      // D3: quote yes, Pay Now only if the organizer turned it on.
      suppressPayNow: !isPresenterPayNowEnabled(input.eventSettings),
      // One email, not two: the caller folds the fee into its welcome.
      suppressConfirmationEmail: input.callerSendsFeeEmail === true,
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
      return null;
    }

    // Only a freshly-created payable row produces a fee email. A
    // `linked-existing` row is one they already had (and were already told
    // about), and a `race-lost` duplicate was cancelled.
    if (outcome.status !== "created" || !input.callerSendsFeeEmail) return null;
    return buildPresenterFeeEmailExtras(outcome.registrationId, {
      payNowEnabled: isPresenterPayNowEnabled(input.eventSettings),
    });
  } catch (err) {
    apiLogger.error(
      { err, speakerId: speaker.id, eventId: speaker.eventId },
      "presenter-signup:failed",
    );
  }
  return null;
}

/**
 * Build the fee block + quote attachment for the submitter-welcome email.
 *
 * Failure-isolated like everything else here: a broken PDF or a missing
 * relation must not cost someone their account, so any problem degrades to
 * "no fee block, no attachment" and is logged. The registration itself still
 * exists and the organizer can re-send the quote from the dashboard.
 */
export async function buildPresenterFeeEmailExtras(
  registrationId: string,
  opts: { payNowEnabled: boolean } = { payNowEnabled: false },
): Promise<PresenterFeeEmailExtras | null> {
  try {
    const registration = await db.registration.findUnique({
      where: { id: registrationId },
      include: {
        attendee: true,
        ticketType: { select: { name: true, price: true, currency: true } },
        pricingTier: { select: { name: true, price: true, currency: true } },
        promoCode: { select: { code: true } },
        billingAccount: {
          select: {
            name: true, contactName: true, email: true, phone: true,
            address: true, city: true, state: true, zipCode: true,
            country: true, taxNumber: true,
          },
        },
        event: {
          select: {
            name: true, slug: true, code: true, organizationId: true, startDate: true,
            venue: true, city: true, taxRate: true, taxLabel: true,
            bankDetails: true, supportEmail: true,
            organization: {
              select: {
                name: true, companyName: true, companyAddress: true,
                companyCity: true, companyState: true, companyZipCode: true,
                companyCountry: true, taxId: true, logo: true,
              },
            },
          },
        },
      },
    });
    if (!registration) return null;

    const price = Number(
      registration.originalPrice ??
        registration.pricingTier?.price ??
        registration.ticketType?.price ??
        0,
    );
    const currency =
      registration.pricingTier?.currency ?? registration.ticketType?.currency ?? "USD";
    const amount = `${currency} ${price.toFixed(2)}`;
    const typeName = registration.ticketType?.name ?? "";
    const tierName = registration.pricingTier?.name ?? "";
    const label = [typeName, tierName].filter(Boolean).join(" · ");

    // The closing sentence must agree with the organizer's Pay Now toggle
    // (plan D3). Saying "payment is not required" while a Pay Now button sits
    // underneath is the kind of contradiction nobody reads twice, so the copy
    // and the button are decided together, here, from one flag.
    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL || "https://events.meetingmindsgroup.com";
    const payLink =
      opts.payNowEnabled && registration.event.slug && price > 0
        ? `${appUrl}/e/${registration.event.slug}/confirmation?id=${registration.id}` +
          `&name=${encodeURIComponent(registration.attendee.firstName)}` +
          `&price=${price}&currency=${currency}`
        : "";
    const note = payLink
      ? "A quote is attached to this email. You can pay online now, or the organizing team will confirm your fee once your submission has been reviewed."
      : "A quote is attached to this email. Payment is not required to submit your abstract; the organizing team will confirm your fee once your submission has been reviewed.";

    // Dynamic values are event/organizer-authored, but escape anyway: a tier
    // name is free text an organizer types, and this lands in an HTML email.
    const payCta = payLink
      ? `\n  <div style="margin-top:12px;"><a href="${escapeHtml(payLink)}" style="display:inline-block;background:#00aade;color:#ffffff;padding:10px 24px;text-decoration:none;border-radius:6px;font-weight:500;font-size:14px;">Pay Now</a></div>`
      : "";
    const html = `
<div style="margin:16px 0;padding:16px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;">
  <p style="margin:0 0 8px 0;font-weight:600;">Your presenter registration fee</p>
  <p style="margin:0 0 4px 0;font-size:20px;font-weight:700;">${escapeHtml(amount)}</p>
  <p style="margin:0 0 8px 0;color:#6b7280;font-size:14px;">${escapeHtml(label)}</p>
  <p style="margin:0;color:#6b7280;font-size:14px;">${escapeHtml(note)}</p>${payCta}
</div>`.trim();

    const text = [
      "Your presenter registration fee",
      amount,
      label,
      note,
      payLink ? `Pay Now: ${payLink}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    let attachment: PresenterFeeEmailExtras["attachment"] = null;
    if (price > 0) {
      try {
        const { buffer, filename } = await buildQuotePDFFromRegistration(registration);
        attachment = { content: buffer.toString("base64"), name: filename };
      } catch (err) {
        apiLogger.error({ err, registrationId }, "presenter-signup:quote-pdf-failed");
      }
    }

    return { registrationId, html, text, attachment };
  } catch (err) {
    apiLogger.error({ err, registrationId }, "presenter-signup:fee-extras-failed");
    return null;
  }
}
