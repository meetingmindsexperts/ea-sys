import Stripe from "stripe";
import { decryptSecret } from "@/lib/eventsair-client";
import { apiLogger } from "@/lib/logger";

// NOTE: `db` is imported LAZILY inside the org-key readers, not at module
// scope — the pure currency helpers below are imported by tests (and could be
// by other light contexts) that must not drag the Prisma client in.
async function getDb() {
  const { db } = await import("@/lib/db");
  return db;
}

/**
 * Per-organization Stripe credentials (Platform decision item 7, Aug 4 2026).
 *
 * Stored encrypted in `Organization.settings.stripe` (the Zoom/EventsAir
 * pattern — see src/app/api/organization/stripe/credentials/route.ts):
 *   { secretKeyEncrypted, secretKeyLast4, keyMode, webhookSecretEncrypted?, configuredAt }
 *
 * Resolution chain everywhere: org key (if configured) → env STRIPE_SECRET_KEY.
 * An org with NO configured key gets the ENV client — so master (MMG,
 * nothing configured) behaves byte-identically to the pre-feature singleton,
 * and every historical PaymentIntent stays reachable through the same account.
 *
 * Cache: bounded module Map keyed by orgId (or "__env__") with a 5-minute
 * TTL. The TTL is the CROSS-PROCESS staleness guard — the worker container
 * and the other blue-green color never see the credentials PUT, so without
 * it they'd hold a replaced key forever (the known Zoom token-cache gotcha).
 * `invalidateStripeClientCache()` gives the saving process immediacy.
 */
type CacheEntry = { client: Stripe; expiresAt: number };
const clientCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const ENV_CACHE_KEY = "__env__";

type StripeOrgSettings = {
  secretKeyEncrypted?: string;
  webhookSecretEncrypted?: string;
};

function readStripeSettings(settings: unknown): StripeOrgSettings | null {
  if (typeof settings !== "object" || settings === null) return null;
  const stripe = (settings as Record<string, unknown>).stripe;
  if (typeof stripe !== "object" || stripe === null) return null;
  return stripe as StripeOrgSettings;
}

function cacheGet(key: string): Stripe | null {
  const entry = clientCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    clientCache.delete(key);
    return null;
  }
  return entry.client;
}

function cacheSet(key: string, client: Stripe): void {
  // Bounded: evict the oldest entry once at capacity (insertion order —
  // good enough for a cache that realistically holds a handful of orgs).
  if (clientCache.size >= CACHE_MAX_ENTRIES && !clientCache.has(key)) {
    const oldest = clientCache.keys().next().value;
    if (oldest !== undefined) clientCache.delete(oldest);
  }
  clientCache.set(key, { client, expiresAt: Date.now() + CACHE_TTL_MS });
}

function envClient(): Stripe {
  const cached = cacheGet(ENV_CACHE_KEY);
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  const client = new Stripe(key);
  cacheSet(ENV_CACHE_KEY, client);
  return client;
}

/**
 * Resolve the Stripe client for an organization: the org's own configured
 * key when present, else the env fallback. Pass null/undefined for
 * explicitly env-scoped call sites (e.g. the legacy webhook route).
 *
 * A failed org-settings read falls back to the env client with an error
 * log rather than failing the payment operation — for master (no org keys)
 * the fallback IS the correct client, and a DB blip must not break a
 * charge. If the org HAS a key configured but decryption fails, we throw:
 * silently charging through the platform's env account instead of the
 * tenant's would cross Stripe accounts.
 */
export async function getStripe(organizationId?: string | null): Promise<Stripe> {
  if (!organizationId) return envClient();

  const cached = cacheGet(organizationId);
  if (cached) return cached;

  let stripeSettings: StripeOrgSettings | null = null;
  try {
    const db = await getDb();
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    stripeSettings = readStripeSettings(org?.settings);
  } catch (err) {
    apiLogger.error(
      { err, organizationId },
      "stripe:org-settings-read-failed; falling back to env client",
    );
    return envClient();
  }

  if (!stripeSettings?.secretKeyEncrypted) {
    // Org has no key configured — env fallback is the designed behavior.
    // Cache under the org's own key so repeated calls skip the DB read;
    // the TTL picks up a later credential save within 5 minutes.
    const client = envClient();
    cacheSet(organizationId, client);
    return client;
  }

  // Org key configured: decryption failure is a hard error (never silently
  // cross into the platform's env Stripe account).
  const secretKey = decryptSecret(stripeSettings.secretKeyEncrypted);
  const client = new Stripe(secretKey);
  cacheSet(organizationId, client);
  return client;
}

/**
 * Drop the cached client for an org (and the env entry, which the org may
 * have been falling back to). Called by the credentials PUT/DELETE so the
 * saving process applies the new key immediately; other processes converge
 * within the cache TTL.
 */
export function invalidateStripeClientCache(organizationId: string): void {
  clientCache.delete(organizationId);
}

/**
 * The org's webhook signing secret (decrypted), or null when the org is
 * unknown or has no webhook secret configured. Used by the per-org webhook
 * route /api/webhooks/stripe/[orgId]; the legacy route keeps the env
 * STRIPE_WEBHOOK_SECRET. Deliberately NOT cached — webhook volume is low
 * and a stale signing secret would reject real payment events.
 */
export async function getOrgStripeWebhookSecret(
  organizationId: string,
): Promise<string | null> {
  try {
    const db = await getDb();
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const stripeSettings = readStripeSettings(org?.settings);
    if (!stripeSettings?.webhookSecretEncrypted) return null;
    return decryptSecret(stripeSettings.webhookSecretEncrypted);
  } catch (err) {
    apiLogger.error(
      { err, organizationId },
      "stripe:org-webhook-secret-read-failed",
    );
    return null;
  }
}

/** Test-only: reset the module cache between cases. */
export function _resetStripeClientCacheForTests(): void {
  clientCache.clear();
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
