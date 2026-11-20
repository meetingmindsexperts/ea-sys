/**
 * The rates the abstract form offers an author (owner, Nov 20, 2026; plan
 * docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md, decision P1).
 *
 * An author registers on their own registration type and pays later. Which
 * price each type shows:
 *
 *   - the event has presenter rates (a "Presenter..." rate on any type): the
 *     presenter rate on sale for each type that has one, as since Aug 11, 2026;
 *   - it has none: each type's ORDINARY rate on sale now, the one a delegate
 *     registering today would get, so the journey is the same on every event.
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
import { tierNeedsSponsorCode } from "@/lib/code-required-tiers";
import {
  isPresenterTierName,
  presenterRateOptions,
  type PresenterRateOption,
  type PresenterTicketTypeCandidate,
} from "@/lib/presenter-tiers";

/** A registration type as the public event API returns it, with its own price for a type that has no rates. */
export type AuthorRateTypeCandidate = PresenterTicketTypeCandidate & {
  price?: number | string | null;
  currency?: string | null;
  /** The type's own availability (its dates and seats), computed server-side. */
  canPurchase?: boolean;
};

export interface AuthorRateContext {
  /** The event's registration switch (Settings, Registration). Off: no ordinary rate is offered. */
  registrationOpen?: boolean;
  /** Rates that need a sponsor's code (code-required-tiers.ts): never offered here. */
  codeRequiredTiers?: readonly string[] | null;
}

/** Does any type on the event carry a presenter rate? Then presenter rates are what authors are offered. */
export function eventHasPresenterRates(ticketTypes: AuthorRateTypeCandidate[] | null | undefined): boolean {
  if (!Array.isArray(ticketTypes)) return false;
  return ticketTypes.some(
    (tt) => tt.isActive !== false && (tt.pricingTiers ?? []).some((t) => isPresenterTierName(t.name)),
  );
}

/**
 * One type's ordinary rate on sale now: the first open rate in the organiser's
 * order that is neither a presenter rate nor a sponsor's. A type that HAS rates
 * and none open offers nothing (its own price is usually 0 on an event priced
 * by rate, and falling back to it once let people register free); a type with
 * no rates at all is sold at its own price.
 */
function ordinaryRateOption(tt: AuthorRateTypeCandidate, sponsorLinkSlugs: readonly string[]): PresenterRateOption | null {
  const tiers = tt.pricingTiers ?? [];
  if (tiers.length === 0) {
    const price = Number(tt.price);
    if (tt.canPurchase === false || !Number.isFinite(price)) return null;
    return { ticketTypeId: tt.id, ticketTypeName: tt.name, tierId: null, tierName: "", price, currency: tt.currency || "USD" };
  }
  const open = tiers
    .filter((t) => t.canPurchase !== false && !isPresenterTierName(t.name) && !tierNeedsSponsorCode(t.name, sponsorLinkSlugs))
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
  const sponsorLinkSlugs = context.codeRequiredTiers ?? [];
  return ticketTypes
    .filter((tt) => tt.isActive !== false)
    .map((tt) => ordinaryRateOption(tt, sponsorLinkSlugs))
    .filter((o): o is PresenterRateOption => o !== null);
}
