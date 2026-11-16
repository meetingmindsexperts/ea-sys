/**
 * Which outstanding registrations a promo code has already paid for in full,
 * and what their payment status should be (owner, Nov 16, 2026).
 *
 * Before that date a code entered AFTER registering left a fully covered
 * registration UNPAID. `applyPromoCodeToRegistration` now settles it; this is
 * the same decision for the rows that already exist, asked by
 * scripts/settle-promo-covered-registrations.ts. Pure, so the script's choice
 * is tested without a database.
 */
import { paymentStatusForFee, promoSponsorCovers } from "@/lib/promo-redeem";
import { registrationChargesNothing } from "@/lib/registration-financials";

/** The stored columns the decision reads. */
export interface SettlementCandidate {
  status: string;
  paymentStatus: string;
  groupId?: string | null;
  originalPrice?: unknown;
  discountAmount?: unknown;
  pricingTier?: { price?: unknown } | null;
  ticketType?: { price?: unknown } | null;
  promoCode: { sponsorCoversFee: boolean; sponsorId: string | null } | null;
}

export type SettlementDecision =
  | { settle: true; to: "COMPLIMENTARY" | "INCLUSIVE"; sponsorId: string | null }
  | { settle: false; why: "NOT_OUTSTANDING" | "CANCELLED" | "NO_CODE" | "GROUP_MEMBER" | "STILL_OWES" };

const OUTSTANDING = new Set(["UNPAID", "PENDING", "UNASSIGNED"]);

export function promoSettlement(reg: SettlementCandidate): SettlementDecision {
  if (!OUTSTANDING.has(reg.paymentStatus)) return { settle: false, why: "NOT_OUTSTANDING" };
  if (reg.status === "CANCELLED") return { settle: false, why: "CANCELLED" };
  if (!reg.promoCode) return { settle: false, why: "NO_CODE" };
  // A group member is paid for on the group's invoice; that status is the group's to set.
  if (reg.groupId) return { settle: false, why: "GROUP_MEMBER" };
  // The code must take the WHOLE fee: a discount that equals the price. A free
  // registration with no discount is not this script's business, and a
  // discount larger than the price is stale (registration-financials.ts).
  const discount = Number(reg.discountAmount ?? 0);
  if (!(discount > 0) || !registrationChargesNothing(reg)) return { settle: false, why: "STILL_OWES" };
  const to = paymentStatusForFee(promoSponsorCovers(reg.promoCode, 0), 0);
  if (to === "UNPAID") return { settle: false, why: "STILL_OWES" };
  return { settle: true, to, sponsorId: to === "INCLUSIVE" ? reg.promoCode.sponsorId : null };
}
