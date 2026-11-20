/**
 * The rates the abstract form offers an author (owner, Nov 20, 2026; plan
 * docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md, decision P1).
 *
 * An author registers on their own registration type and pays later. Which
 * price each type shows:
 *
 *   - the event has presenter rates (a "Presenter..." rate on any type): the
 *     presenter rate on sale for each type that has one, as since Aug 11, 2026;
 *   - it has none: each type's ORDINARY rate on sale now, the one the main
 *     Register link would sell a delegate today: the first open rate, in the
 *     organiser's order, among the rate names ticked for the main link
 *     (Settings, Registration; Early Bird, Standard, Onsite unless changed),
 *     so the journey is the same on every event.
 *
 * WHAT IS NEVER AN ORDINARY RATE (review of 08f6b291, HIGH): a rate that is
 * not ticked for the main link (a "Complimentary" or "Inclusive" rate at 0.00
 * exists on real events for staff to assign, and the first version sold it to
 * any author), a sponsor's rate, a presenter rate, and a registration type's
 * OWN price. Organisers open and close rates with the Active switch and leave
 * the type's own price at 0.00, so a type with no open rate has nothing on
 * sale; and an event priced by type alone, with no rates (one draft event on
 * production), can have a type that is itself called "Complimentary". An
 * author is only ever offered a real, open, main-link rate.
 *
 * Before this an event with no presenter rates gave every submitter a free
 * Faculty registration; Faculty is for the people the organisers invite.
 *
 * NO OPTIONS is an answer, not an error: nothing is on sale for an author
 * (registration is closed, every rate is sold out or outside its dates). The
 * author still signs up and submits, no registration is made, and the
 * organisers give one later. It is never a reason to make a free registration.
 *
 * ONE function for the form (which renders the options) and the sign-up doors
 * (which resolve the chosen type's rate again on the server): the price shown
 * is the price charged, and the door never takes a rate or a price from the
 * browser. Client-safe: pure, no Node imports.
 */
import { registerTierSlug } from "@/lib/main-register-tiers";
import { mainLinkTiers } from "@/lib/public-availability";
import {
  isPresenterTierName,
  presenterRateOptions,
  type PresenterRateOption,
  type PresenterTicketTypeCandidate,
} from "@/lib/presenter-tiers";

/** A registration type as the public event API returns it. */
export type AuthorRateTypeCandidate = PresenterTicketTypeCandidate;

export interface AuthorRateContext {
  /** The event's registration switch (Settings, Registration). Off: no ordinary rate is offered. */
  registrationOpen?: boolean;
  /** Rates that need a sponsor's code (code-required-tiers.ts): never offered here. */
  codeRequiredTiers?: readonly string[] | null;
  /** The rate names ticked for the main Register link (main-register-tiers.ts); the default when absent. */
  mainRegisterTiers?: unknown;
}

/** Does any type on the event carry a presenter rate? Then presenter rates are what authors are offered. */
export function eventHasPresenterRates(ticketTypes: AuthorRateTypeCandidate[] | null | undefined): boolean {
  if (!Array.isArray(ticketTypes)) return false;
  return ticketTypes.some(
    (tt) => tt.isActive !== false && (tt.pricingTiers ?? []).some((t) => isPresenterTierName(t.name)),
  );
}

/**
 * One type's ordinary rate on sale now: the first open rate, in the
 * organiser's order, whose name is one the main Register link sells
 * (`mainLinkNames`: ticked, and not a sponsor's). None open: the type offers
 * nothing. Its own price is never the fallback.
 */
function ordinaryRateOption(tt: AuthorRateTypeCandidate, mainLinkNames: readonly string[]): PresenterRateOption | null {
  const open = (tt.pricingTiers ?? [])
    .filter((t) => t.canPurchase !== false && !isPresenterTierName(t.name) && mainLinkNames.includes(registerTierSlug(t.name)))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const tier = open[0];
  if (!tier) return null;
  const price = Number(tier.price);
  if (!Number.isFinite(price)) return null;
  return { ticketTypeId: tt.id, ticketTypeName: tt.name, tierId: tier.id, tierName: tier.name, price, currency: tier.currency || "USD" };
}

/** The registration types an author may pick from right now, each with the rate it would be charged. */
export function authorRateOptions(
  ticketTypes: AuthorRateTypeCandidate[] | null | undefined,
  context: AuthorRateContext = {},
): PresenterRateOption[] {
  if (!Array.isArray(ticketTypes)) return [];
  if (eventHasPresenterRates(ticketTypes)) return presenterRateOptions(ticketTypes);
  // Ordinary rates are the public form's rates, so the public form's switch governs them.
  if (context.registrationOpen === false) return [];
  // The names the main Register link sells: ticked, minus sponsor-only rates.
  const mainLinkNames = mainLinkTiers(context.mainRegisterTiers, context.codeRequiredTiers);
  return ticketTypes
    .filter((tt) => tt.isActive !== false)
    .map((tt) => ordinaryRateOption(tt, mainLinkNames))
    .filter((o): o is PresenterRateOption => o !== null);
}
