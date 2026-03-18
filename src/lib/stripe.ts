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
