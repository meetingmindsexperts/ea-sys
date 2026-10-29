/**
 * The rules for redeeming a promo code on a NEW registration, shared by the
 * public register route, `createRegistration()` (the desk walk-in) and the
 * desk's code check, so a code the desk shows as valid is the code the
 * registration accepts (Oct 29, 2026). Pure and client-safe.
 *
 * The usage counters (maxUses, maxUsesPerEmail) are decided inside the
 * creating transaction under a row lock (`claimPromoCodeInTx` in
 * promo-code-service); the desk's check reads `usedCount` only as a hint.
 */

import { isSponsorCoveredCode } from "@/lib/code-required-tiers";

export type PromoRefusal =
  | "INVALID_PROMO_CODE"
  | "PROMO_CODE_NOT_APPLICABLE"
  | "PROMO_CODE_NOT_SPONSOR"
  | "PROMO_CODE_EXHAUSTED"
  | "PROMO_CODE_EMAIL_LIMIT";

export const PROMO_REFUSAL_MESSAGE: Record<PromoRefusal, string> = {
  INVALID_PROMO_CODE: "Invalid or expired promo code",
  PROMO_CODE_NOT_APPLICABLE: "Promo code not applicable to this ticket type",
  PROMO_CODE_NOT_SPONSOR: "This is not a sponsor code. A sponsor code covers the whole fee.",
  PROMO_CODE_EXHAUSTED: "Promo code usage limit reached",
  PROMO_CODE_EMAIL_LIMIT: "Promo code already used with this email",
};

export interface RedeemablePromo {
  isActive: boolean;
  validFrom: Date | string | null;
  validUntil: Date | string | null;
  ticketTypes: { ticketTypeId: string }[];
  sponsorId: string | null;
  sponsorCoversFee: boolean;
  discountType: string;
  discountValue: unknown;
}

/** Why this code cannot be used for this type, or null. Counters are not checked here. */
export function promoRefusal(
  promo: RedeemablePromo | null | undefined,
  opts: { now: Date; ticketTypeId: string; requireSponsorCover?: boolean },
): PromoRefusal | null {
  if (!promo || !promo.isActive) return "INVALID_PROMO_CODE";
  if (promo.validFrom && opts.now < new Date(promo.validFrom)) return "INVALID_PROMO_CODE";
  if (promo.validUntil && opts.now > new Date(promo.validUntil)) return "INVALID_PROMO_CODE";
  if (promo.ticketTypes.length > 0 && !promo.ticketTypes.some((t) => t.ticketTypeId === opts.ticketTypeId)) {
    return "PROMO_CODE_NOT_APPLICABLE";
  }
  // A sponsor rate or the desk's Inclusive choice opens only to a code whose
  // sponsor covers the fee, so a discount code cannot pass as sponsor-paid.
  if (opts.requireSponsorCover && !isSponsorCoveredCode(promo)) return "PROMO_CODE_NOT_SPONSOR";
  return null;
}

/**
 * The discount on a price. Clamped: bad stored data (a negative value, a
 * percentage over 100) never yields a surcharge or a discount above the price.
 */
export function promoDiscount(
  promo: Pick<RedeemablePromo, "discountType" | "discountValue">,
  originalPrice: number,
): { discountAmount: number; finalPrice: number } {
  const value = Number(promo.discountValue);
  const raw =
    promo.discountType === "PERCENTAGE"
      ? (originalPrice * Math.min(100, Math.max(0, value))) / 100
      : Math.min(Math.max(0, value), originalPrice);
  const discountAmount = Math.round(raw * 100) / 100;
  return { discountAmount, finalPrice: Math.max(0, originalPrice - discountAmount) };
}

/** The sponsor pays: their code, "Sponsor covers the fee", and nothing left to pay. */
export function promoSponsorCovers(
  promo: Pick<RedeemablePromo, "sponsorCoversFee" | "sponsorId">,
  finalPrice: number,
): boolean {
  return isSponsorCoveredCode(promo) && finalPrice === 0;
}
