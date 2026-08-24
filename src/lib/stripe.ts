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
 * Resolution chain: org key (if configured) → env STRIPE_SECRET_KEY, but the
 * env step is an ALLOW-LIST OF ONE. Only the org named by
 * `STRIPE_ENV_FALLBACK_ORG_ID` may use the shared key; every other org with no
 * key of its own is REFUSED (StripeCredentialsMissingError). On master that
 * variable names MM Group, so MMG behaves byte-identically to the pre-feature
 * singleton and every historical PaymentIntent stays reachable through the same
 * account. On the platform the variable is unset, so no tenant can ever collect
 * into the operator's account. See envFallbackAllowedFor for the reasoning.
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
 * Thrown when an organization has no Stripe key and is NOT permitted to use
 * the env fallback. Carries the org id so the log line and the operator alert
 * name who has to act — the tenant admin, who will never see a registrant's
 * error page.
 */
export class StripeCredentialsMissingError extends Error {
  readonly code = "STRIPE_NOT_CONFIGURED";
  constructor(readonly organizationId: string) {
    super("This organization has not configured Stripe payment credentials");
    this.name = "StripeCredentialsMissingError";
  }
}

/**
 * Which org (if any) may fall back to the env `STRIPE_SECRET_KEY`.
 *
 * Owner ruling, Aug 24 2026: on the platform silo a tenant with no Stripe key
 * must FAIL LOUDLY. It must never collect into MM Group's account. Before this,
 * "no org key → env client" was unconditional, and the platform was safe only
 * because `STRIPE_SECRET_KEY` happened to be unset there — an implicit
 * guarantee resting on an absent variable, where setting it once for a test
 * would silently route every unconfigured tenant's registrants into the
 * operator's account. Cross-account money is unrecoverable (see the note on
 * getStripe); a refused charge is retried.
 *
 * An org ID rather than a boolean. The load-bearing reason is that an ABSENT
 * variable means nobody falls back, so the platform is safe by omission rather
 * than by remembering to opt out — the same inversion as the `/uploads`
 * deny-list → allow-list flip: make the safe behaviour structural, not
 * circumstantial. The secondary reason is that it stays correct if master ever
 * grows a second Organization row (it has exactly one today, MM Group, verified
 * Aug 24 2026), where a boolean would hand the shared key to whoever arrived.
 *
 * NOTE, master: MM Group has NO org-level Stripe key configured (verified the
 * same day), so it relies entirely on this fallback. That makes the variable
 * load-bearing for live payments, not a formality. Configuring MMG's own key
 * under Settings → Integrations is what would eventually let it be unset.
 *
 * Deliberately its OWN variable rather than reusing `DEFAULT_ORG_ID` or
 * `TENANCY_ENFORCE_HOST`. Those answer different questions (which org to assume
 * for an unresolved host; is host resolution enforced) and merely correlate
 * today. Overloading one means a tenancy flag toggled for a test changes where
 * money lands.
 *
 * MASTER DEPLOY ORDER: set `STRIPE_ENV_FALLBACK_ORG_ID` to MM Group's org id
 * BEFORE deploying this, or MMG checkouts refuse. `src/instrumentation.ts`
 * logs a boot-time error when a key is present with no org allowed to use it,
 * so a missed step surfaces immediately rather than at the first checkout.
 */
function envFallbackAllowedFor(organizationId: string): boolean {
  const allowed = process.env.STRIPE_ENV_FALLBACK_ORG_ID?.trim();
  return !!allowed && allowed === organizationId;
}

/**
 * Resolve the Stripe client for an organization: the org's own configured
 * key when present, else the env fallback. Pass null/undefined for
 * explicitly env-scoped call sites (e.g. the legacy webhook route).
 *
 * Failure semantics (review HIGH-2): a failed org-settings read is retried
 * once and then THROWS — the read is the only way to know whether this org
 * has its own key, and guessing "no key → env" for a tenant that DOES have
 * one would collect money into the platform's Stripe account instead of the
 * tenant's (cross-account money is unrecoverable; a failed charge retries).
 * Same rule for a stored key that fails to decrypt. Successful resolutions
 * are cached (5-min TTL) so this only bites on a cold cache during a DB
 * outage — a window where the surrounding payment operation would fail on
 * its own DB reads anyway.
 *
 * NEXTAUTH_SECRET rotation note: stored keys are encrypted under
 * sha256(NEXTAUTH_SECRET). When rotating, set NEXTAUTH_SECRET_FALLBACK to
 * the OLD secret (decrypt-only support in decryptSecret) or re-save every
 * org's Stripe/AI keys — otherwise keyed tenants' payments hard-fail (the
 * intended direction: never silently cross into the env account).
 */
export async function getStripe(organizationId?: string | null): Promise<Stripe> {
  if (!organizationId) return envClient();

  const cached = cacheGet(organizationId);
  if (cached) return cached;

  let stripeSettings: StripeOrgSettings | null = null;
  try {
    stripeSettings = await readOrgStripeSettingsWithRetry(organizationId);
  } catch (err) {
    apiLogger.error(
      { err, organizationId },
      "stripe:org-settings-read-failed; REFUSING env fallback (cross-account guard)",
    );
    throw new Error(
      "Stripe credentials could not be resolved for this organization — try again",
    );
  }

  if (!stripeSettings?.secretKeyEncrypted) {
    if (!envFallbackAllowedFor(organizationId)) {
      // Error level on purpose: this is a tenant who cannot take money, and
      // apiLogger.error is what reaches the operator alert. Deliberately NOT
      // cached — a refusal must clear the moment a key is saved, and caching
      // it would hold the outage for the TTL.
      apiLogger.error(
        { organizationId, envKeyPresent: !!process.env.STRIPE_SECRET_KEY },
        "stripe:no-org-key-and-env-fallback-refused",
      );
      throw new StripeCredentialsMissingError(organizationId);
    }
    // The one org permitted the shared key (master / MM Group). Cache under
    // the org's own key so repeated calls skip the DB read; the TTL picks up
    // a later credential save within 5 minutes.
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

/** One retry on the settings read — transient pooler blips are common; a
 *  second consecutive failure propagates to the caller (see getStripe). */
async function readOrgStripeSettingsWithRetry(
  organizationId: string,
): Promise<StripeOrgSettings | null> {
  const db = await getDb();
  const read = async () => {
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    return readStripeSettings(org?.settings);
  };
  try {
    return await read();
  } catch {
    return await read();
  }
}

/**
 * Drop the cached client for an org. Called by the credentials PUT/DELETE so
 * the saving process applies the new key immediately; other processes
 * converge within the cache TTL. (The "__env__" entry is deliberately NOT
 * touched — the env key is immutable at runtime.)
 */
export function invalidateStripeClientCache(organizationId: string): void {
  clientCache.delete(organizationId);
}

export interface OrgWebhookSecretInfo {
  webhookSecret: string;
  /** Plain recognition hint stored at save time — "live" | "test" | null.
   *  Used by the per-org webhook route's livemode cross-check (review M2). */
  keyMode: "live" | "test" | null;
}

/**
 * The org's webhook signing secret (decrypted) + stored keyMode, or null
 * when the org is unknown or has no webhook secret configured. Used by the
 * per-org webhook route /api/webhooks/stripe/[orgId]; the legacy route keeps
 * the env STRIPE_WEBHOOK_SECRET. Deliberately NOT cached — webhook volume is
 * low and a stale signing secret would reject real payment events.
 */
export async function getOrgStripeWebhookSecret(
  organizationId: string,
): Promise<OrgWebhookSecretInfo | null> {
  try {
    const db = await getDb();
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const stripeSettings = readStripeSettings(org?.settings) as
      | (StripeOrgSettings & { keyMode?: unknown })
      | null;
    if (!stripeSettings?.webhookSecretEncrypted) return null;
    return {
      webhookSecret: decryptSecret(stripeSettings.webhookSecretEncrypted),
      keyMode:
        stripeSettings.keyMode === "live" || stripeSettings.keyMode === "test"
          ? stripeSettings.keyMode
          : null,
    };
  } catch (err) {
    apiLogger.error(
      { err, organizationId },
      "stripe:org-webhook-secret-read-failed",
    );
    return null;
  }
}


/**
 * Verify a Stripe webhook signature.
 *
 * `constructEvent` is static crypto: it uses ONLY the signing secret, never the
 * API key. Both webhook routes previously reached for `getStripe(...)` here,
 * which coupled signature verification to credential resolution — harmless
 * while the env key existed, but once an unconfigured org refuses (above) it
 * would break a tenant who had saved a webhook secret and not yet an API key.
 * A dedicated key-less client removes the question.
 */
let signatureClient: Stripe | null = null;

export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string,
  webhookSecret: string,
): Stripe.Event {
  signatureClient ??= new Stripe("sk_signature_verification_only");
  return signatureClient.webhooks.constructEvent(payload, signature, webhookSecret);
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
