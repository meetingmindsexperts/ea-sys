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
 * - A free rate (the Complimentary rate, or any rate at 0): complimentary.
 * - A paid rate: cash or card (a 100% discount code there registers them
 *   complimentary: the desk's way to comp on a type with no Complimentary
 *   rate), or a sponsor's code for a sponsored delegate.
 */
import { tierNeedsSponsorCode } from "@/lib/code-required-tiers";

export type WalkInPaymentChoice = "complimentary" | "cash" | "card" | "inclusive";

export function walkInPaymentChoices(
  rate: { name: string | null; price: number },
  codeRequiredSlugs: readonly string[],
): WalkInPaymentChoice[] {
  if (tierNeedsSponsorCode(rate.name, codeRequiredSlugs)) return ["inclusive"];
  if (rate.price <= 0) return ["complimentary"];
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
