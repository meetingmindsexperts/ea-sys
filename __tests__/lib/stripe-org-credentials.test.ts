/**
 * Per-org Stripe accessor (src/lib/stripe.ts).
 *
 * MOST OF THIS FILE DESCRIBES MASTER, where STRIPE_ENV_FALLBACK_ORG_ID names
 * MM Group, so the org under test is the one org permitted the shared key:
 *
 *   org key configured → org client
 *   org WITHOUT a key  → the SAME env client instance as getStripe(null)
 *   no env key either  → the existing throw
 *
 * The platform shape (variable unset, so NOBODY falls back) is the separate
 * describe block at the bottom. Set it there, not here, so the two deployments
 * stay legible as two different sets of guarantees.
 *
 * Plus the cache mechanics (TTL, invalidation, bounded) and the webhook-secret
 * reader used by /api/webhooks/stripe/[orgId].
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { orgFindUnique, mockApiLogger } = vi.hoisted(() => ({
  orgFindUnique: vi.fn(),
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: { organization: { findUnique: orgFindUnique } },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

// The Stripe SDK constructor is mocked so each `new Stripe(key)` returns a
// distinguishable object carrying its key.
vi.mock("stripe", () => ({
  default: class MockStripe {
    key: string;
    webhooks: { constructEvent: (b: unknown, sig: string, secret: string) => unknown };
    constructor(key: string) {
      this.key = key;
      this.webhooks = {
        constructEvent: (_b: unknown, _sig: string, secret: string) => ({
          id: "evt_1",
          verifiedWith: secret,
        }),
      };
    }
  },
}));

import {
  getStripe,
  invalidateStripeClientCache,
  getOrgStripeWebhookSecret,
  verifyWebhookSignature,
  StripeCredentialsMissingError,
  _resetStripeClientCacheForTests,
} from "@/lib/stripe";
import { encryptSecret } from "@/lib/eventsair-client";

const ORG = "org_test_1";

function orgWithStripe(settings: Record<string, unknown> | null) {
  orgFindUnique.mockResolvedValue(settings === null ? null : { settings });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetStripeClientCacheForTests();
  process.env.STRIPE_SECRET_KEY = "sk_test_env";
  // Master: this org IS the one allowed to use the shared key.
  process.env.STRIPE_ENV_FALLBACK_ORG_ID = ORG;
  process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "test-secret-for-crypto";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.STRIPE_ENV_FALLBACK_ORG_ID;
});

describe("getStripe resolution chain", () => {
  it("null org → env client", async () => {
    const client = await getStripe(null);
    expect((client as unknown as { key: string }).key).toBe("sk_test_env");
    expect(orgFindUnique).not.toHaveBeenCalled();
  });

  it("org WITHOUT a configured key → the IDENTICAL env client instance (existing-data guarantee)", async () => {
    orgWithStripe({});
    const envClient = await getStripe(null);
    const orgClient = await getStripe(ORG);
    expect(orgClient).toBe(envClient);
  });

  it("org WITH a configured key → org client built from the decrypted key", async () => {
    orgWithStripe({ stripe: { secretKeyEncrypted: encryptSecret("sk_live_org") } });
    const client = await getStripe(ORG);
    expect((client as unknown as { key: string }).key).toBe("sk_live_org");
  });

  it("no org key AND no env key → throws the existing message", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    orgWithStripe({});
    await expect(getStripe(ORG)).rejects.toThrow("STRIPE_SECRET_KEY is not configured");
  });

  it("org-settings read failure retries ONCE, then THROWS — never guesses env (review HIGH-2 cross-account guard)", async () => {
    orgFindUnique.mockRejectedValue(new Error("pool timeout"));
    await expect(getStripe(ORG)).rejects.toThrow(
      "Stripe credentials could not be resolved for this organization — try again",
    );
    expect(orgFindUnique).toHaveBeenCalledTimes(2);
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG }),
      expect.stringContaining("REFUSING env fallback"),
    );
  });

  it("transient first read failure recovers on the in-call retry", async () => {
    orgFindUnique
      .mockRejectedValueOnce(new Error("pool blip"))
      .mockResolvedValueOnce({ settings: {} });
    const client = await getStripe(ORG);
    expect((client as unknown as { key: string }).key).toBe("sk_test_env");
    expect(orgFindUnique).toHaveBeenCalledTimes(2);
  });

  it("org key configured but decryption fails → HARD throw (never silently cross Stripe accounts)", async () => {
    orgWithStripe({ stripe: { secretKeyEncrypted: "not:valid:ciphertext" } });
    await expect(getStripe(ORG)).rejects.toThrow();
  });
});

describe("client cache", () => {
  it("second call within TTL skips the DB read", async () => {
    orgWithStripe({ stripe: { secretKeyEncrypted: encryptSecret("sk_live_org") } });
    const a = await getStripe(ORG);
    const b = await getStripe(ORG);
    expect(a).toBe(b);
    expect(orgFindUnique).toHaveBeenCalledTimes(1);
  });

  it("invalidateStripeClientCache forces a fresh resolve (creds PUT immediacy)", async () => {
    orgWithStripe({ stripe: { secretKeyEncrypted: encryptSecret("sk_live_old") } });
    const a = await getStripe(ORG);
    invalidateStripeClientCache(ORG);
    orgWithStripe({ stripe: { secretKeyEncrypted: encryptSecret("sk_live_new") } });
    const b = await getStripe(ORG);
    expect((a as unknown as { key: string }).key).toBe("sk_live_old");
    expect((b as unknown as { key: string }).key).toBe("sk_live_new");
    expect(orgFindUnique).toHaveBeenCalledTimes(2);
  });

  it("entries expire after the 5-minute TTL (cross-process convergence guard)", async () => {
    vi.useFakeTimers();
    orgWithStripe({ stripe: { secretKeyEncrypted: encryptSecret("sk_live_old") } });
    await getStripe(ORG);
    expect(orgFindUnique).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    orgWithStripe({ stripe: { secretKeyEncrypted: encryptSecret("sk_live_new") } });
    const b = await getStripe(ORG);
    expect((b as unknown as { key: string }).key).toBe("sk_live_new");
    expect(orgFindUnique).toHaveBeenCalledTimes(2);
  });

  it("the no-key fallback is cached under the org id (no repeated DB read) but invalidation clears it", async () => {
    orgWithStripe({});
    await getStripe(ORG);
    await getStripe(ORG);
    expect(orgFindUnique).toHaveBeenCalledTimes(1);
    invalidateStripeClientCache(ORG);
    await getStripe(ORG);
    expect(orgFindUnique).toHaveBeenCalledTimes(2);
  });
});

describe("getOrgStripeWebhookSecret", () => {
  it("returns the decrypted secret + stored keyMode when configured", async () => {
    orgWithStripe({ stripe: { webhookSecretEncrypted: encryptSecret("whsec_abc"), keyMode: "live" } });
    expect(await getOrgStripeWebhookSecret(ORG)).toEqual({
      webhookSecret: "whsec_abc",
      keyMode: "live",
    });
  });

  it("keyMode absent/garbage maps to null (livemode check skipped)", async () => {
    orgWithStripe({ stripe: { webhookSecretEncrypted: encryptSecret("whsec_abc"), keyMode: "weird" } });
    expect(await getOrgStripeWebhookSecret(ORG)).toEqual({
      webhookSecret: "whsec_abc",
      keyMode: null,
    });
  });

  it("returns null for an unknown org", async () => {
    orgWithStripe(null);
    expect(await getOrgStripeWebhookSecret("org_missing")).toBeNull();
  });

  it("returns null when no webhook secret is configured", async () => {
    orgWithStripe({ stripe: { secretKeyEncrypted: encryptSecret("sk_live_org") } });
    expect(await getOrgStripeWebhookSecret(ORG)).toBeNull();
  });

  it("returns null + error log on a read failure (unauthenticated route degrades to 400)", async () => {
    orgFindUnique.mockRejectedValue(new Error("boom"));
    expect(await getOrgStripeWebhookSecret(ORG)).toBeNull();
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG }),
      "stripe:org-webhook-secret-read-failed",
    );
  });
});

/**
 * The platform silo. Owner ruling, Aug 24 2026: a tenant with no Stripe key
 * must fail LOUDLY and must never collect into MM Group's account.
 *
 * The guarantee is structural, not circumstantial: with the variable unset,
 * NOBODY falls back, so setting STRIPE_SECRET_KEY there (a stray test key, a
 * copied .env) cannot silently route a tenant's registrants into the operator's
 * account. Every case below keeps STRIPE_SECRET_KEY present on purpose — that
 * is the dangerous configuration, and it must still refuse.
 */
describe("platform silo — no env fallback for any tenant", () => {
  beforeEach(() => {
    delete process.env.STRIPE_ENV_FALLBACK_ORG_ID;
    process.env.STRIPE_SECRET_KEY = "sk_live_PLATFORM_OPERATOR";
  });

  it("refuses an org with no key, even though an env key is present", async () => {
    orgWithStripe({});
    await expect(getStripe(ORG)).rejects.toBeInstanceOf(StripeCredentialsMissingError);
  });

  it("names the org in the refusal and logs at ERROR so the operator is alerted", async () => {
    orgWithStripe({});
    await expect(getStripe(ORG)).rejects.toMatchObject({
      code: "STRIPE_NOT_CONFIGURED",
      organizationId: ORG,
    });
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, envKeyPresent: true }),
      "stripe:no-org-key-and-env-fallback-refused",
    );
  });

  it("a fallback org id that names a DIFFERENT org does not help this one", async () => {
    process.env.STRIPE_ENV_FALLBACK_ORG_ID = "some_other_org";
    orgWithStripe({});
    await expect(getStripe(ORG)).rejects.toBeInstanceOf(StripeCredentialsMissingError);
  });

  it("a tenant WITH its own key is unaffected", async () => {
    orgWithStripe({ stripe: { secretKeyEncrypted: encryptSecret("sk_live_tenant") } });
    const client = await getStripe(ORG);
    expect((client as unknown as { key: string }).key).toBe("sk_live_tenant");
  });

  it("does not cache the refusal — saving a key takes effect on the next call", async () => {
    orgWithStripe({});
    await expect(getStripe(ORG)).rejects.toBeInstanceOf(StripeCredentialsMissingError);

    orgWithStripe({ stripe: { secretKeyEncrypted: encryptSecret("sk_live_just_saved") } });
    const client = await getStripe(ORG);
    expect((client as unknown as { key: string }).key).toBe("sk_live_just_saved");
  });

  it("getStripe(null) still resolves the env client (the legacy env-scoped call site)", async () => {
    const client = await getStripe(null);
    expect((client as unknown as { key: string }).key).toBe("sk_live_PLATFORM_OPERATOR");
  });
});

/**
 * Signature verification is static crypto and must not depend on any API key.
 * It used to go through getStripe(orgId), which would now REFUSE a tenant that
 * had saved a webhook secret but not yet a key — rejecting real payment events
 * as unverifiable.
 */
describe("verifyWebhookSignature", () => {
  it("verifies with no env key and no org key configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_ENV_FALLBACK_ORG_ID;

    const event = verifyWebhookSignature("{}", "t=1,v1=sig", "whsec_tenant");

    expect(event).toMatchObject({ id: "evt_1", verifiedWith: "whsec_tenant" });
    expect(orgFindUnique).not.toHaveBeenCalled();
  });
});
