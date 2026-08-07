/**
 * Read-only promo-code rules, in one place.
 *
 * These checks (active, date window, usage caps, ticket-type applicability)
 * were hand-rolled separately in the public `validate-promo` route and in
 * `promo-code-service.applyPromoCodeToRegistration`. Group registration needed
 * them too, and a third copy of "is this code usable?" is exactly how the
 * three surfaces end up disagreeing about whether a code is valid — so they
 * live here now.
 *
 * Pure and DB-free: the caller loads the code and the usage counts and passes
 * them in. That keeps the rules unit-testable and lets each caller keep its
 * own query shape (the group path needs an aggregate over many members; the
 * single-registration path does not).
 *
 * NOTE: `applyPromoCodeToRegistration` still carries its own inline copy — it
 * validates inside a transaction alongside the write, so folding it in is a
 * separate change. Do that before adding a fourth caller.
 */

export type PromoRejectionCode =
  | "NOT_FOUND"
  | "INACTIVE"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "MAX_USES_REACHED"
  | "MAX_USES_PER_EMAIL_REACHED"
  | "NOT_APPLICABLE";

export interface PromoRejection {
  ok: false;
  code: PromoRejectionCode;
  message: string;
}

/** The fields of a PromoCode these rules read. */
export interface PromoCodeRules {
  isActive: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
  maxUses: number | null;
  usedCount: number;
  maxUsesPerEmail: number | null;
  /** Empty = applies to every ticket type. */
  applicableTicketTypeIds: string[];
  discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  discountValue: number;
}

export interface PromoUsabilityInput {
  promo: PromoCodeRules | null;
  now: Date;
  /** Redemptions already made by this email, when the caller enforces that cap. */
  emailUses?: number;
  /**
   * Ticket types this use would cover. A restricted code is usable when AT
   * LEAST ONE is applicable — the discount is then computed against only the
   * applicable portion (see `promoDiscountFor`), so a mixed group is not
   * rejected outright, nor silently discounted on ineligible people.
   */
  ticketTypeIds: string[];
}

/** Rules only — no money. Returns null when the code is usable. */
export function checkPromoUsable(input: PromoUsabilityInput): PromoRejection | null {
  const { promo, now, emailUses, ticketTypeIds } = input;

  if (!promo) {
    return { ok: false, code: "NOT_FOUND", message: "That promo code isn't valid for this event." };
  }
  if (!promo.isActive) {
    return { ok: false, code: "INACTIVE", message: "That promo code is no longer active." };
  }
  if (promo.validFrom && now < promo.validFrom) {
    return { ok: false, code: "NOT_YET_VALID", message: "That promo code isn't active yet." };
  }
  if (promo.validUntil && now > promo.validUntil) {
    return { ok: false, code: "EXPIRED", message: "That promo code has expired." };
  }
  if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) {
    return { ok: false, code: "MAX_USES_REACHED", message: "That promo code has reached its usage limit." };
  }
  if (
    promo.maxUsesPerEmail !== null &&
    emailUses !== undefined &&
    emailUses >= promo.maxUsesPerEmail
  ) {
    return {
      ok: false,
      code: "MAX_USES_PER_EMAIL_REACHED",
      message: "You've already used that promo code the maximum number of times.",
    };
  }
  if (promo.applicableTicketTypeIds.length > 0) {
    const anyApplicable = ticketTypeIds.some((id) =>
      promo.applicableTicketTypeIds.includes(id),
    );
    if (!anyApplicable) {
      return {
        ok: false,
        code: "NOT_APPLICABLE",
        message: "That promo code doesn't apply to the selected registration types.",
      };
    }
  }
  return null;
}

/**
 * The discount for a given base amount, clamped so bad admin data can never
 * produce a surcharge or a negative total: a percentage is held to 0–100, and
 * a fixed amount can never exceed the base it is discounting.
 */
export function promoDiscountFor(
  promo: Pick<PromoCodeRules, "discountType" | "discountValue">,
  base: number,
): number {
  const raw = Number(promo.discountValue);
  if (!Number.isFinite(raw) || raw <= 0 || base <= 0) return 0;
  const amount =
    promo.discountType === "PERCENTAGE"
      ? (base * Math.min(100, Math.max(0, raw))) / 100
      : Math.min(Math.max(0, raw), base);
  return Math.round(amount * 100) / 100;
}

/**
 * The portion of a group's subtotal a code actually discounts.
 *
 * An unrestricted code discounts the whole subtotal. A code restricted to
 * certain ticket types discounts only the members on those types — so a
 * "Physician 20% off" code applied to a mixed group takes 20% off the
 * physicians, not off the nurses too. The invoice still shows ONE discount
 * line (the owner's rule: the code is against the full and final invoice);
 * this only decides the base that line is computed from.
 */
export function promoEligibleBase(
  applicableTicketTypeIds: string[],
  members: Array<{ ticketTypeId: string; price: number }>,
): number {
  const restricted = applicableTicketTypeIds.length > 0;
  const total = members.reduce(
    (sum, m) =>
      sum +
      (!restricted || applicableTicketTypeIds.includes(m.ticketTypeId) ? m.price : 0),
    0,
  );
  return Math.round(total * 100) / 100;
}
