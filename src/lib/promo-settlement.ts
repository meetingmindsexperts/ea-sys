/**
 * When a promo code that takes the whole fee may SETTLE a registration, and
 * which existing registrations one has already paid for in full (owner,
 * Nov 16, 2026).
 *
 * Before that date a code entered AFTER registering left a fully covered
 * registration UNPAID. `applyPromoCodeToRegistration` now settles it, and
 * scripts/settle-promo-covered-registrations.ts makes the same decision for
 * the rows that already exist. Both ask `settlementBlocker`, so the service
 * and the script cannot disagree about who is left alone (review of a9573a45:
 * the first version of the service had none of these checks and the script had
 * some). Pure, so both are tested without a database.
 */
import { paymentStatusForFee, promoSponsorCovers } from "@/lib/promo-redeem";
import { registrationChargesNothing } from "@/lib/registration-financials";

/** Why a registration is not settled by a code, though the code takes the whole fee. */
export type SettlementBlocker =
  /** A cancelled registration is not settled; its code use was released at the cancel. */
  | "CANCELLED"
  /** A group member is paid for on the group's invoice: that status is the group's to set. */
  | "GROUP_MEMBER"
  /** Money was already taken (a deposit at the desk): Complimentary would hide it from refunds and credit notes. */
  | "HAS_PAYMENTS";

export function settlementBlocker(
  reg: { status: string; groupId?: string | null },
  /** The sum of this registration's PAID payments. */
  paidTotal: number,
): SettlementBlocker | null {
  if (reg.status === "CANCELLED") return "CANCELLED";
  if (reg.groupId) return "GROUP_MEMBER";
  if (paidTotal > 0) return "HAS_PAYMENTS";
  return null;
}

/** The stored columns the script's decision reads. */
export interface SettlementCandidate {
  status: string;
  paymentStatus: string;
  groupId?: string | null;
  originalPrice?: unknown;
  discountAmount?: unknown;
  pricingTier?: { price?: unknown } | null;
  ticketType?: { price?: unknown } | null;
  promoCode: { sponsorCoversFee: boolean; sponsorId: string | null } | null;
  /** The sum of its PAID payments. */
  paidTotal: number;
  /** An open Stripe checkout: someone may be paying the old price right now. */
  stripeCheckoutSessionId?: string | null;
}

export type SettlementDecision =
  | { settle: true; to: "COMPLIMENTARY" | "INCLUSIVE"; sponsorId: string | null }
  | { settle: false; why: "NOT_OUTSTANDING" | "NO_CODE" | "STILL_OWES" | "CHECKOUT_OPEN" | SettlementBlocker };

const OUTSTANDING = new Set(["UNPAID", "PENDING", "UNASSIGNED"]);

export function promoSettlement(reg: SettlementCandidate): SettlementDecision {
  if (!OUTSTANDING.has(reg.paymentStatus)) return { settle: false, why: "NOT_OUTSTANDING" };
  if (!reg.promoCode) return { settle: false, why: "NO_CODE" };
  const blocker = settlementBlocker(reg, reg.paidTotal);
  if (blocker) return { settle: false, why: blocker };
  // The script cannot close a checkout tab, so it leaves a payment in progress
  // to a person. (The service expires the session when it settles.)
  if (reg.paymentStatus === "PENDING" || reg.stripeCheckoutSessionId) return { settle: false, why: "CHECKOUT_OPEN" };
  // The code must take the WHOLE fee: a discount that equals the price. A free
  // registration with no discount is not this rule's business, and a discount
  // larger than the price is stale (registration-financials.ts).
  const discount = Number(reg.discountAmount ?? 0);
  if (!(discount > 0) || !registrationChargesNothing(reg)) return { settle: false, why: "STILL_OWES" };
  const to = paymentStatusForFee(promoSponsorCovers(reg.promoCode, 0), 0);
  if (to === "UNPAID") return { settle: false, why: "STILL_OWES" };
  return { settle: true, to, sponsorId: to === "INCLUSIVE" ? reg.promoCode.sponsorId : null };
}
