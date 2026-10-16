/**
 * Pricing a registration at the rate its form link carries
 * (docs/REGISTRATION_FORM_LINKS_PLAN.md). Shared by the send (which stamps the
 * rate) and the completion form (which confirms it, or applies it to the type
 * the person picks), so the two can never price the same link differently.
 */
import type { PaymentStatus } from "@prisma/client";
import { isTierOnSale, type PricingTierCandidate } from "@/lib/current-pricing-tier";
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

/**
 * The link's rate on one registration type. Complimentary needs no rate and
 * costs nothing. A named rate must exist on the type and be on sale (owner
 * D3: a closed rate is refused, never swapped for another).
 */
export function priceAtLinkRate<T extends PricingTierCandidate>(
  tiers: T[],
  rate: RegistrationFormRate,
  now: Date,
): { ok: true; tier: T | null; price: number } | { ok: false; code: "RATE_NOT_ON_TYPE" | "RATE_CLOSED" } {
  if (rate.kind === "complimentary") return { ok: true, tier: null, price: 0 };
  const tier = tiers.find((t) => registerTierSlug(t.name) === rate.slug);
  if (!tier) return { ok: false, code: "RATE_NOT_ON_TYPE" };
  if (!isTierOnSale(tier, now)) return { ok: false, code: "RATE_CLOSED" };
  return { ok: true, tier, price: Number(tier.price) };
}
