/**
 * What a desk QR allows (docs/ONSITE_DESK_PLAN.md §8.2, §8.5, §10): the one
 * rate it was made for, the Exhibitor type for an exhibitor QR (never for the
 * other two), the sponsor's code it carries, and nothing that costs money.
 * Checked by the public register route, before its transaction (type and
 * rate) and inside it (the code and the price). Also which rate a
 * free-registration QR is for (`freeDeskRate`). Client-safe.
 */
import { isExhibitorBadge } from "@/lib/badge-layout";
import { isComplimentaryRate } from "@/lib/desk-walkin-payment";
import { registerTierSlug } from "@/lib/main-register-tiers";
import { eventIsFull, mainRegisterTarget, tierAvailability } from "@/lib/public-availability";

/**
 * `free` (Nov 11, 2026): the rate the public Register link lands on, while it
 * costs nothing for every registration type. An image from before that day
 * does not know the kind: its form reads the link as the ordinary public form
 * (password step and all) and sends no token, and its register route would
 * refuse the token as malformed if one arrived. Either way nothing registers
 * wrongly.
 */
export const DESK_QR_KINDS = ["exhibitor", "complimentary", "free"] as const;
export type DeskQrKind = (typeof DESK_QR_KINDS)[number];

export function isDeskQrKind(value: unknown): value is DeskQrKind {
  return (DESK_QR_KINDS as readonly unknown[]).includes(value);
}

/**
 * Whether the form takes a code. Only an exhibitor's: it is what credits their
 * sponsor. The other two are free already, and a code would only move the
 * registration onto a sponsor or a discount nobody at the desk chose.
 */
export function deskQrTakesCode(kind: DeskQrKind): boolean {
  return kind === "exhibitor";
}

/**
 * Whether a rate that closed online still works on this QR (§8.5). The
 * Exhibitor and Complimentary rates do: they exist for the desk. The free
 * kind never does: it is the public Register link without the password step,
 * so a free Early Bird that gave way to a paid rate stays closed.
 */
export function deskQrReopensClosedRate(kind: DeskQrKind): boolean {
  return kind !== "free";
}

export type DeskQrRefusal =
  | "DESK_QR_WRONG_RATE"
  | "DESK_QR_WRONG_TYPE"
  | "DESK_QR_NEEDS_APPROVAL"
  | "DESK_QR_CODE_REQUIRED"
  | "DESK_QR_WRONG_CODE"
  | "DESK_QR_NOT_FREE";

export const DESK_QR_REFUSAL_MESSAGE: Record<DeskQrRefusal, string> = {
  DESK_QR_WRONG_RATE: "This desk QR is for another registration form. Please scan the QR at the desk again.",
  DESK_QR_WRONG_TYPE: "This registration type is not available on this desk QR.",
  DESK_QR_NEEDS_APPROVAL: "This registration needs the organiser's approval. Please register at the desk.",
  DESK_QR_CODE_REQUIRED: "Enter the code your sponsor gave you. A discount code does not apply here.",
  DESK_QR_WRONG_CODE: "This desk QR does not take that code. Please ask at the desk.",
  DESK_QR_NOT_FREE: "This registration would need a payment. Please register at the desk.",
};

/**
 * The type and the rate, before anything is written. A rate that needs the
 * organiser's approval is refused (owner, Oct 29): the person would be left
 * pending with a barcode the desk cannot admit.
 */
export function deskQrTypeRefusal(
  desk: { kind: DeskQrKind; rate: string },
  ticketTypeName: string,
  tier: { name: string; requiresApproval: boolean } | null,
): DeskQrRefusal | null {
  if (!tier || registerTierSlug(tier.name) !== desk.rate) return "DESK_QR_WRONG_RATE";
  const exhibitor = isExhibitorBadge(ticketTypeName);
  if (desk.kind === "exhibitor" ? !exhibitor : exhibitor) return "DESK_QR_WRONG_TYPE";
  return tier.requiresApproval ? "DESK_QR_NEEDS_APPROVAL" : null;
}

/**
 * The code and the price, once the code is claimed. An exhibitor needs a
 * sponsor's code that covers the fee (theirs, typed on the form: the code is
 * what credits the sponsor), and exactly that code when the QR names one; a
 * complimentary or free QR takes no code. Either way nothing may be left to
 * pay: a free QR printed before the organiser put a price on the rate is
 * refused here, whatever the desk's panel said when it was printed.
 */
export function deskQrPriceRefusal(
  desk: { kind: DeskQrKind; promoCodeId: string | null },
  claimed: { promoCodeId: string | null; sponsorCovered: boolean; finalPrice: number },
): DeskQrRefusal | null {
  if (desk.kind === "exhibitor") {
    if (!claimed.promoCodeId || !claimed.sponsorCovered) return "DESK_QR_CODE_REQUIRED";
    if (desk.promoCodeId && claimed.promoCodeId !== desk.promoCodeId) return "DESK_QR_WRONG_CODE";
  }
  if (!deskQrTakesCode(desk.kind) && claimed.promoCodeId) return "DESK_QR_WRONG_CODE";
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
    if (!isDeskQrKind(p.kind) || typeof p.rate !== "string" || typeof p.exp !== "number") return null;
    return { kind: p.kind, rate: p.rate, expiresAt: p.exp * 1000 };
  } catch {
    return null;
  }
}

/** What `freeDeskRate` reads of a registration type and its rates. */
export interface FreeRateType {
  name: string;
  quantity: number;
  soldCount: number;
  pricingTiers: Array<{
    name: string;
    price: number;
    isActive: boolean;
    requiresApproval: boolean;
    quantity: number;
    soldCount: number;
    salesStart: Date | string | null;
    salesEnd: Date | string | null;
    sortOrder?: number | null;
  }>;
}

export interface FreeDeskRate {
  /** The rate's name as the organiser wrote it. */
  rateName: string;
  /** Its slug: the form's URL and the only rate the QR may use. */
  slug: string;
  /**
   * The registration types that charge on this rate. Any at all means no QR
   * (owner, Nov 11, 2026: a sheet that refuses most of the people who scan it
   * slows the queue); the panel names them instead.
   */
  paidTypes: string[];
}

/**
 * The rate a free-registration QR is for (docs/ONSITE_DESK_PLAN.md §10), or
 * null when the event has none.
 *
 * It is the rate the public Register link lands on NOW, asked of the same
 * rule that link uses (`mainRegisterTarget`) with the Exhibitor type left out
 * (so where the link would land on a rate only exhibitors have, this is the
 * next rate on sale). The QR gives nothing that rate's own public form does
 * not already give, apart from the password step. That one choice carries the
 * rest: a rate switched off or past its sales end is never
 * picked (a free Early Bird that gave way to a paid Standard stays closed), a
 * sponsor-code rate is never picked, and registration switched off or the
 * event full means no QR.
 *
 * Null too when that rate is the Complimentary rate (it has its own QR), when
 * no type could register free on it (every type charges, or the free ones
 * need approval or have no seats), and for the Exhibitor type alone, which
 * the form never offers on this QR.
 */
export function freeDeskRate(
  event: {
    eventType: string | null | undefined;
    registrationOpen: boolean;
    maxAttendees: number | null;
    seatCount: number;
    mainRegisterTiers: unknown;
    codeRequiredTiers: readonly string[];
    ticketTypes: readonly FreeRateType[];
  },
  now: Date,
): FreeDeskRate | null {
  // A webinar has no desk (§8.6); the QR route refuses one, so offer none.
  if (event.eventType === "WEBINAR") return null;
  // The desk registers people in person, so a full event has no QR even where
  // the public link stays open for a hybrid event's virtual attendance.
  if (eventIsFull(event)) return null;
  const types = event.ticketTypes
    .filter((type) => !isExhibitorBadge(type.name))
    .map((type) => ({
      name: type.name,
      pricingTiers: type.pricingTiers
        .filter((tier) => tier.isActive)
        .map((tier) => ({ ...tier, ...tierAvailability(tier, type, now) })),
    }));
  const landing = mainRegisterTarget({
    registrationOpen: event.registrationOpen,
    eventFull: false,
    eventType: event.eventType,
    ticketTypes: types,
    mainRegisterTiers: event.mainRegisterTiers,
    codeRequiredTiers: event.codeRequiredTiers,
  });
  if (!landing || isComplimentaryRate(landing.name)) return null;

  const slug = registerTierSlug(landing.name);
  // One rate per type on a form: the first with the slug, as the form picks it.
  const onRate = types.flatMap((type) => {
    const tier = type.pricingTiers.find((t) => registerTierSlug(t.name) === slug);
    return tier ? [{ typeName: type.name, tier }] : [];
  });
  // Free is exactly 0: a price that did not read as a number counts as paid.
  const usable = onRate.some(({ tier }) => tier.price === 0 && !tier.requiresApproval && tier.canPurchase);
  if (!usable) return null;
  return {
    rateName: landing.name,
    slug,
    paidTypes: onRate.filter(({ tier }) => tier.price !== 0).map(({ typeName }) => typeName),
  };
}
