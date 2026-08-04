/**
 * Per-org Stripe accessor (src/lib/stripe.ts) — the resolution chain that
 * guarantees existing prod payments stay on the same account:
 *
 *   org key configured → org client
 *   org WITHOUT a key  → the SAME env client instance as getStripe(null)
 *   no env key either  → the existing throw
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
    constructor(key: string) {
      this.key = key;
    }
  },
}));

import {
  getStripe,
  invalidateStripeClientCache,
  getOrgStripeWebhookSecret,
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
  process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "test-secret-for-crypto";
});

afterEach(() => {
  vi.useRealTimers();
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
