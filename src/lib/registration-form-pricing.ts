/**
 * Pricing a registration at the rate its form link carries
 * (docs/REGISTRATION_FORM_LINKS_PLAN.md). Shared by the send (which stamps the
 * rate) and the completion form (which confirms it, or applies it to the type
 * the person picks), so the two can never price the same link differently.
 */
import type { PaymentStatus } from "@prisma/client";
import type { PricingTierCandidate } from "@/lib/current-pricing-tier";
import { registerTierSlug } from "@/lib/main-register-tiers";
import type { RegistrationFormRate } from "@/lib/registration-form-link";

/** Payment statuses a rate may replace: nothing has been paid or is being paid. */
export const RESTAMPABLE_STATUSES: readonly PaymentStatus[] = ["UNASSIGNED", "UNPAID", "COMPLIMENTARY", "INCLUSIVE", "FAILED"];

/** The payment status a rate means. A status holding money is never passed in (callers check RESTAMPABLE_STATUSES). */
export function stampedPaymentStatus(current: PaymentStatus, price: number, sponsorRate: boolean): PaymentStatus {
  if (sponsorRate) return "INCLUSIVE";
  if (price <= 0) return "COMPLIMENTARY";
  return current === "UNPAID" ? "UNPAID" : "UNASSIGNED";
}

/** How the person attends, for the price (a virtual attendee pays the type's virtual price). */
export interface LinkPricingContext {
  isVirtual: boolean;
  /** The registration type's flat virtual price; null means the rate's price applies. */
  virtualPrice: unknown;
}

export const IN_PERSON_PRICING: LinkPricingContext = { isVirtual: false, virtualPrice: null };

/**
 * A rate is open while it is switched on and inside its sale dates. Its seat
 * count is NOT checked here (review of b269ff6e, M2): a person the send gave
 * the rate already holds their place, and a new seat is claimed, against the
 * real limit, when the seat moves (claimSeat / applyRegistrationTransition).
 */
export function isLinkRateOpen(tier: Pick<PricingTierCandidate, "isActive" | "salesStart" | "salesEnd">, now: Date): boolean {
  if (!tier.isActive) return false;
  if (tier.salesStart && tier.salesStart > now) return false;
  return !(tier.salesEnd && tier.salesEnd < now);
}

/** The price at a rate for this person: the virtual price when they attend online and the type has one (review M3). */
export function linkRatePrice(ratePrice: number, ctx: LinkPricingContext): number {
  if (ctx.isVirtual && ctx.virtualPrice != null) return Number(ctx.virtualPrice);
  return ratePrice;
}

/**
 * The link's rate on one registration type. Complimentary needs no rate and
 * costs nothing. A named rate must exist on the type and be open (owner D3: a
 * closed rate is refused, never swapped for another).
 */
export function priceAtLinkRate<T extends PricingTierCandidate>(
  tiers: T[],
  rate: RegistrationFormRate,
  now: Date,
  ctx: LinkPricingContext = IN_PERSON_PRICING,
): { ok: true; tier: T | null; price: number } | { ok: false; code: "RATE_NOT_ON_TYPE" | "RATE_CLOSED" } {
  if (rate.kind === "complimentary") return { ok: true, tier: null, price: 0 };
  const tier = tiers.find((t) => registerTierSlug(t.name) === rate.slug);
  if (!tier) return { ok: false, code: "RATE_NOT_ON_TYPE" };
  if (!isLinkRateOpen(tier, now)) return { ok: false, code: "RATE_CLOSED" };
  return { ok: true, tier, price: linkRatePrice(Number(tier.price), ctx) };
}

/** What `linkMayReprice` reads from the registration. */
export interface LinkRepriceState {
  paymentStatus: PaymentStatus;
  refundedAmount: unknown;
  promoCodeId: string | null;
  groupId: string | null;
  ticketTypeId: string | null;
  pricingTierId: string | null;
  _count: { payments: number; invoices: number };
}

/**
 * May a completion still set this registration's type and price from the
 * link's rate? Only while the registration is as the link left it (review of
 * b269ff6e, H1): nothing paid, refunded or invoiced, no promo code, not in a
 * group, and, when it has a type, still carrying the stamp the send made (the
 * link's rate on that type, and the payment status that rate means). Anything
 * staff changed after the send (a payment, a comp, a sponsor) wins: the link
 * then only completes the person's details, like a link without a rate.
 */
export function linkMayReprice(
  reg: LinkRepriceState,
  rate: RegistrationFormRate,
  currentTypeTiers: readonly { id: string; name: string; price: unknown }[],
  sponsorRate: boolean,
  ctx: LinkPricingContext = IN_PERSON_PRICING,
): boolean {
  if (!RESTAMPABLE_STATUSES.includes(reg.paymentStatus)) return false;
  if (Number(reg.refundedAmount ?? 0) > 0) return false;
  if (reg._count.payments > 0 || reg._count.invoices > 0) return false;
  if (reg.promoCodeId || reg.groupId) return false;
  // No type yet: the link's rate applies to the type they choose.
  if (!reg.ticketTypeId) return true;
  const tier = rate.kind === "rate" ? currentTypeTiers.find((t) => registerTierSlug(t.name) === rate.slug) : null;
  if (rate.kind === "rate" && !tier) return false;
  if (reg.pricingTierId !== (tier?.id ?? null)) return false;
  return statusMatchesStamp(reg.paymentStatus, tier ? linkRatePrice(Number(tier.price), ctx) : 0, sponsorRate);
}

/** The payment status a stamp at this price leaves (stampedPaymentStatus keeps UNPAID as UNPAID). */
function statusMatchesStamp(status: PaymentStatus, price: number, sponsorRate: boolean): boolean {
  if (sponsorRate) return status === "INCLUSIVE";
  if (price <= 0) return status === "COMPLIMENTARY";
  return status === "UNASSIGNED" || status === "UNPAID";
}
