/**
 * What a desk QR allows (docs/ONSITE_DESK_PLAN.md §8.2, §8.5): the one rate it
 * was made for, the Exhibitor type for an exhibitor QR (never for a
 * complimentary one), the sponsor's code it carries, and nothing that costs
 * money. Checked by the public register route, before its transaction (type
 * and rate) and inside it (the code and the price). Client-safe.
 */
import { isExhibitorBadge } from "@/lib/badge-layout";
import { registerTierSlug } from "@/lib/main-register-tiers";
import type { DeskQrKind } from "@/lib/desk-qr-token";

export type DeskQrRefusal = "DESK_QR_WRONG_RATE" | "DESK_QR_WRONG_TYPE" | "DESK_QR_WRONG_CODE" | "DESK_QR_NOT_FREE";

export const DESK_QR_REFUSAL_MESSAGE: Record<DeskQrRefusal, string> = {
  DESK_QR_WRONG_RATE: "This desk QR is for another registration form. Please scan the QR at the desk again.",
  DESK_QR_WRONG_TYPE: "This registration type is not available on this desk QR.",
  DESK_QR_WRONG_CODE: "This desk QR is for another sponsor. Please scan the QR at the desk again.",
  DESK_QR_NOT_FREE: "This registration would need a payment. Please register at the desk.",
};

/** The type and the rate, before anything is written. */
export function deskQrTypeRefusal(
  desk: { kind: DeskQrKind; rate: string },
  ticketTypeName: string,
  tierName: string | null,
): DeskQrRefusal | null {
  if (!tierName || registerTierSlug(tierName) !== desk.rate) return "DESK_QR_WRONG_RATE";
  const exhibitor = isExhibitorBadge(ticketTypeName);
  if (desk.kind === "exhibitor" ? !exhibitor : exhibitor) return "DESK_QR_WRONG_TYPE";
  return null;
}

/**
 * The code and the price, once the code is claimed. An exhibitor QR needs its
 * own sponsor's code covering the fee; a complimentary one takes no code.
 * Either way nothing may be left to pay.
 */
export function deskQrPriceRefusal(
  desk: { kind: DeskQrKind; promoCodeId: string | null },
  claimed: { promoCodeId: string | null; sponsorCovered: boolean; finalPrice: number },
): DeskQrRefusal | null {
  if (desk.kind === "exhibitor" && (claimed.promoCodeId !== desk.promoCodeId || !claimed.sponsorCovered)) {
    return "DESK_QR_WRONG_CODE";
  }
  if (desk.kind === "complimentary" && claimed.promoCodeId) return "DESK_QR_WRONG_CODE";
  return claimed.finalPrice > 0 ? "DESK_QR_NOT_FREE" : null;
}

/**
 * What the form needs to know about a desk QR to show desk mode: its kind,
 * rate and expiry, read from the token's body without checking the signature
 * (the browser cannot). Only the look of the form follows it; the register
 * route verifies the token and enforces every rule, so a forged one gains
 * nothing but a form that is refused on submit.
 */
export function readDeskQrClaims(token: string | null | undefined): { kind: DeskQrKind; rate: string; expiresAt: number } | null {
  const body = token?.split(".")[0];
  if (!body) return null;
  try {
    const base64 = body.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(body.length / 4) * 4, "=");
    const p = JSON.parse(atob(base64)) as { kind?: unknown; rate?: unknown; exp?: unknown };
    if ((p.kind !== "exhibitor" && p.kind !== "complimentary") || typeof p.rate !== "string" || typeof p.exp !== "number") return null;
    return { kind: p.kind, rate: p.rate, expiresAt: p.exp * 1000 };
  } catch {
    return null;
  }
}
