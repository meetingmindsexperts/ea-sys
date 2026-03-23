import Stripe from "stripe";

let instance: Stripe | null = null;

/** Lazy-init Stripe SDK singleton (same pattern as Brevo in email.ts) */
export function getStripe(): Stripe {
  if (!instance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
    instance = new Stripe(key);
  }
  return instance;
}

/**
 * Zero-decimal currencies where 1 unit = 1 smallest denomination.
 * For these, Stripe expects the amount as-is (e.g. ¥500 → 500).
 * For all others, multiply by 100 (e.g. $5.00 → 500).
 * https://docs.stripe.com/currencies#zero-decimal
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

/** Check if a currency code is zero-decimal (no cents). */
export function isZeroDecimalCurrency(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase());
}

/** Convert a display amount to the smallest Stripe unit. */
export function toStripeAmount(amount: number, currency: string): number {
  return isZeroDecimalCurrency(currency)
    ? Math.round(amount)
    : Math.round(amount * 100);
}

/** Convert a Stripe smallest-unit amount back to display amount. */
export function fromStripeAmount(amount: number, currency: string): number {
  return isZeroDecimalCurrency(currency) ? amount : amount / 100;
}
