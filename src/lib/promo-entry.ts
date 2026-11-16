/**
 * A promo code typed on a form and never checked (owner, Nov 16, 2026).
 *
 * The public registration form sent a code only once the Apply button had
 * accepted it. A code typed and left there was dropped without a word: the
 * person registered at the full fee, found it owing on the next page and
 * entered the code again there, where a code that covers the whole fee leaves
 * the registration Unpaid. Thirteen of the twenty nurses on one sponsor's code
 * went that way (4th GCC Hematology Hub).
 *
 * So a form asks this before it submits. A code it returns is checked first:
 * accepted, it rides the registration; refused, the form stops and says so.
 * The onsite desk has always refused a typed, unapplied code (desk-panel.tsx).
 * Client-safe, no dependencies.
 */

/** The last answer of the code check, as far as this rule reads it. */
export type PromoCheck = { valid: boolean } | null;

/**
 * The code the person typed that no check has accepted, or null when there is
 * nothing to check: no code, a code already accepted, or a field the form is
 * not showing (a code that came by link onto a form that takes none must not
 * block a submit the person cannot correct).
 */
export function unappliedPromoCode(typed: string, fieldShown: boolean, result: PromoCheck): string | null {
  const code = typed.trim();
  if (!fieldShown || !code) return null;
  return result?.valid ? null : code;
}
