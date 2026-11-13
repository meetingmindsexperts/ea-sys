/**
 * How a desk walk-in may be paid, decided by the rate chosen (owner, Oct 29,
 * 2026). Complimentary belongs to the event's free rates, the Complimentary
 * rate above all, never to a paid one: before this, "Complimentary" sat beside
 * Cash and Card on Early Bird, so a comp landed on a priced rate and counted
 * against its seats. Shared by the walk-in form and the walk-in route, so the
 * buttons offered and the payments accepted are one rule. Client-safe.
 *
 * - A sponsor-link rate (one whose link needs a sponsor's code): the sponsor's
 *   code only.
 * - The Complimentary rate, free: complimentary only (owner, Nov 13, 2026).
 *   The rate already says who pays, so "Sponsor (Inclusive)" beside it was a
 *   second answer to a settled question; production has no sponsored
 *   registration on one.
 * - A free rate named Inclusive that nobody marked as a link: the sponsor's
 *   code only, the same ruling the other way round. It is what the sponsor
 *   choice on a free rate was first kept for (review of 51cc3801: production
 *   has one), and the sponsor keeps the credit.
 * - Any other free rate (Standard at 0 on a free event): free, or a sponsor's
 *   code when a sponsor brings them.
 * - A paid rate: cash or card (a 100% discount code there registers them
 *   complimentary: the desk's way to comp on a type with no Complimentary
 *   rate), or a sponsor's code for a sponsored delegate.
 */
import { tierNeedsSponsorCode } from "@/lib/code-required-tiers";
import { registerTierSlug } from "@/lib/main-register-tiers";

export type WalkInPaymentChoice = "complimentary" | "cash" | "card" | "inclusive";

/**
 * The event's Complimentary rate (owner, Oct 29): the rate whose slug is
 * "complimentary". The one rule: the desk QR's complimentary form, the
 * walk-in's button label and the day summary's Free/Comp split all ask here.
 */
export function isComplimentaryRate(rateName: string | null): boolean {
  return !!rateName && registerTierSlug(rateName) === "complimentary";
}

/**
 * The button's word for a choice (owner, Nov 2, 2026). A rate that simply
 * costs nothing (Standard at 0 on a free event) reads "Free", so the desk does
 * not appear to waive a fee; only the Complimentary rate reads "Complimentary".
 * The label only: both are still saved as COMPLIMENTARY.
 */
export function walkInPaymentLabel(choice: WalkInPaymentChoice, rateName: string | null): string {
  if (choice === "complimentary") return isComplimentaryRate(rateName) ? "Complimentary" : "Free";
  if (choice === "inclusive") return "Sponsor (Inclusive)";
  return choice === "cash" ? "Cash" : "Card";
}

/** A rate named Inclusive, by its slug: the sponsor channel's usual name (code-required-tiers.ts). */
export function isInclusiveRate(rateName: string | null): boolean {
  return !!rateName && registerTierSlug(rateName) === "inclusive";
}

/** The ways to pay on a rate that costs nothing: the rate's own name decides when it says who pays. */
function freeRateChoices(rateName: string | null): WalkInPaymentChoice[] {
  if (isComplimentaryRate(rateName)) return ["complimentary"];
  if (isInclusiveRate(rateName)) return ["inclusive"];
  return ["complimentary", "inclusive"];
}

export function walkInPaymentChoices(
  rate: { name: string | null; price: number },
  codeRequiredSlugs: readonly string[],
): WalkInPaymentChoice[] {
  if (tierNeedsSponsorCode(rate.name, codeRequiredSlugs)) return ["inclusive"];
  if (rate.price <= 0) return freeRateChoices(rate.name);
  return ["cash", "card", "inclusive"];
}

/**
 * Whether the route may accept this payment on this rate. "covered" is cash or
 * card where a code took the whole fee, so it stands wherever those do.
 */
export function walkInPaymentAllowed(
  payment: WalkInPaymentChoice | "covered",
  rate: { name: string | null; price: number },
  codeRequiredSlugs: readonly string[],
): boolean {
  const choices = walkInPaymentChoices(rate, codeRequiredSlugs);
  return payment === "covered" ? choices.includes("cash") : choices.includes(payment);
}
