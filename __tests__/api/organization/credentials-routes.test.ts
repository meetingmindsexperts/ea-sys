/**
 * Per-org credentials routes (item 7, phase 4):
 *   /api/organization/stripe/credentials  GET/PUT/DELETE
 *   /api/organization/ai/credentials      GET/PUT/DELETE
 *
 * Pins: RBAC matrix (401/403), GET masking (no ciphertext or plaintext key in
 * any response), PUT blank-keeps-existing, first-time-requires-key, provider-
 * preference key validation, rate limit 429 + Retry-After, DELETE removes
 * only its sub-key (+ resets a dangling preference), and the Stripe cache
 * invalidation on save.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAuth,
  orgFindUnique,
  mockUpdateOrgSettings,
  mockCheckRateLimit,
  mockInvalidate,
  mockApiLogger,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  orgFindUnique: vi.fn(),
  mockUpdateOrgSettings: vi.fn(),
  mockCheckRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  mockInvalidate: vi.fn(),
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: { organization: { findUnique: orgFindUnique } } }));
vi.mock("@/lib/event-settings", () => ({ updateOrganizationSettings: mockUpdateOrgSettings }));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/stripe", () => ({ invalidateStripeClientCache: mockInvalidate }));

import { GET as stripeGet, PUT as stripePut, DELETE as stripeDelete } from "@/app/api/organization/stripe/credentials/route";
import { GET as aiGet, PUT as aiPut, DELETE as aiDelete } from "@/app/api/organization/ai/credentials/route";
import { encryptSecret } from "@/lib/eventsair-client";

const ORG = "org1";
const adminSession = { user: { id: "u1", organizationId: ORG, role: "ADMIN" } };

function putReq(body: unknown) {
  return new Request("http://localhost/api", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function deleteReq(body?: unknown) {
  return new Request("http://localhost/api", {
    method: "DELETE",
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockAuth.mockResolvedValue(adminSession);
  orgFindUnique.mockResolvedValue({ settings: {} });
  mockUpdateOrgSettings.mockResolvedValue({});
  process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "test-secret-for-crypto";
  process.env.ANTHROPIC_API_KEY = "sk-ant-env";
  delete process.env.OPENAI_API_KEY;
});

describe("RBAC matrix (both route families)", () => {
  it.each([
    ["no session", null, 401],
    ["org-null session", { user: { id: "u1", organizationId: null, role: "SUPER_ADMIN" } }, 401],
    ["ORGANIZER", { user: { id: "u1", organizationId: ORG, role: "ORGANIZER" } }, 403],
    ["MEMBER", { user: { id: "u1", organizationId: ORG, role: "MEMBER" } }, 403],
  ])("%s → %i on stripe GET + ai PUT", async (_label, session, status) => {
    mockAuth.mockResolvedValue(session);
    expect((await stripeGet()).status).toBe(status);
    expect((await aiPut(putReq({ anthropicApiKey: "x" }))).status).toBe(status);
  });
});

describe("stripe credentials", () => {
  it("GET masks: booleans + last4 + webhookUrl, never ciphertext", async () => {
    orgFindUnique.mockResolvedValue({
      settings: {
        stripe: {
          secretKeyEncrypted: encryptSecret("sk_live_secret1234"),
          webhookSecretEncrypted: encryptSecret("whsec_x"),
          secretKeyLast4: "1234",
          keyMode: "live",
          configuredAt: "2026-08-04T00:00:00.000Z",
        },
      },
    });
    const res = await stripeGet();
    const json = await res.json();
    expect(json).toMatchObject({
      configured: true,
      hasSecretKey: true,
      hasWebhookSecret: true,
      secretKeyLast4: "1234",
      keyMode: "live",
    });
    expect(json.webhookUrl).toMatch(new RegExp(`/api/webhooks/stripe/${ORG}$`));
    expect(JSON.stringify(json)).not.toContain("Encrypted");
    expect(JSON.stringify(json)).not.toContain("sk_live_secret1234");
  });

  it("PUT first-time save without a secret key → 400 + warn", async () => {
    const res = await stripePut(putReq({ webhookSecret: "whsec_only" }));
    expect(res.status).toBe(400);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "stripe:credentials-first-save-missing-secret-key",
    );
    expect(mockUpdateOrgSettings).not.toHaveBeenCalled();
  });

  it("PUT blank secretKey keeps the existing ciphertext; new webhookSecret saved; cache invalidated", async () => {
    const existingCt = encryptSecret("sk_live_old");
    orgFindUnique.mockResolvedValue({
      settings: { stripe: { secretKeyEncrypted: existingCt, secretKeyLast4: "_old", keyMode: "live" } },
    });
    const res = await stripePut(putReq({ webhookSecret: "whsec_new" }));
    expect(res.status).toBe(200);
    const patch = mockUpdateOrgSettings.mock.calls[0][1] as { stripe: Record<string, unknown> };
    expect(patch.stripe.secretKeyEncrypted).toBe(existingCt);
    expect(patch.stripe.secretKeyLast4).toBe("_old");
    expect(typeof patch.stripe.webhookSecretEncrypted).toBe("string");
    expect(mockInvalidate).toHaveBeenCalledWith(ORG);
  });

  it("PUT new secretKey re-encrypts + refreshes last4/keyMode", async () => {
    const res = await stripePut(putReq({ secretKey: "sk_test_abcd9999" }));
    expect(res.status).toBe(200);
    const patch = mockUpdateOrgSettings.mock.calls[0][1] as { stripe: Record<string, unknown> };
    expect(patch.stripe.secretKeyLast4).toBe("9999");
    expect(patch.stripe.keyMode).toBe("test");
    expect(patch.stripe.secretKeyEncrypted).not.toContain("sk_test");
  });

  it("PUT rate limited → 429 + Retry-After", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 120 });
    const res = await stripePut(putReq({ secretKey: "sk_test_x" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
  });

  it("DELETE removes only settings.stripe (function patch) + invalidates the cache", async () => {
    mockUpdateOrgSettings.mockImplementation(async (_org: string, patch: unknown) => {
      const fn = patch as (cur: Record<string, unknown>) => Record<string, unknown>;
      const next = fn({ stripe: { a: 1 }, zoom: { keep: true } });
      expect(next.stripe).toBeUndefined();
      expect(next.zoom).toEqual({ keep: true });
      return next;
    });
    const res = await stripeDelete();
    expect(res.status).toBe(200);
    expect(mockInvalidate).toHaveBeenCalledWith(ORG);
  });
});

describe("ai credentials", () => {
  it("GET masks both providers + reports env fallback availability", async () => {
    orgFindUnique.mockResolvedValue({
      settings: {
        anthropic: { apiKeyEncrypted: encryptSecret("sk-ant-org"), apiKeyLast4: "-org" },
        ai: { helpChatProvider: "openai" },
      },
    });
    const res = await aiGet();
    const json = await res.json();
    expect(json).toMatchObject({
      helpChatProvider: "openai",
      anthropic: { configured: true, apiKeyLast4: "-org", envFallbackAvailable: true },
      openai: { configured: false, envFallbackAvailable: false },
    });
    expect(JSON.stringify(json)).not.toContain("Encrypted");
    expect(JSON.stringify(json)).not.toContain("sk-ant-org");
  });

  it("PUT selecting openai with no openai key anywhere → 400 + warn", async () => {
    const res = await aiPut(putReq({ helpChatProvider: "openai" }));
    expect(res.status).toBe(400);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "ai:credentials-provider-without-key",
    );
  });

  it("PUT selecting openai WITH the key in the same request → saved", async () => {
    const res = await aiPut(putReq({ helpChatProvider: "openai", openaiApiKey: "sk-oai-new" }));
    expect(res.status).toBe(200);
    const patch = mockUpdateOrgSettings.mock.calls[0][1] as Record<string, { apiKeyLast4?: string; helpChatProvider?: string }>;
    expect(patch.openai.apiKeyLast4).toBe("-new");
    expect(patch.ai.helpChatProvider).toBe("openai");
  });

  it("PUT saving one provider's key leaves the other's stored ciphertext untouched (no patch key)", async () => {
    orgFindUnique.mockResolvedValue({
      settings: { anthropic: { apiKeyEncrypted: encryptSecret("sk-ant-org") } },
    });
    await aiPut(putReq({ openaiApiKey: "sk-oai-new" }));
    const patch = mockUpdateOrgSettings.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.anthropic).toBeUndefined();
    expect(patch.openai).toBeDefined();
  });

  it("PUT with nothing to save → 400 + warn", async () => {
    const res = await aiPut(putReq({}));
    expect(res.status).toBe(400);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.anything(), "ai:credentials-empty-save");
  });

  it("DELETE clears the provider sub-key AND resets a dangling preference to anthropic", async () => {
    mockUpdateOrgSettings.mockImplementation(async (_org: string, patch: unknown) => {
      const fn = patch as (cur: Record<string, unknown>) => Record<string, unknown>;
      const next = fn({
        openai: { apiKeyEncrypted: "x" },
        ai: { helpChatProvider: "openai" },
        zoom: { keep: true },
      });
      expect(next.openai).toBeUndefined();
      expect((next.ai as Record<string, unknown>).helpChatProvider).toBe("anthropic");
      expect(next.zoom).toEqual({ keep: true });
      return next;
    });
    const res = await aiDelete(deleteReq({ provider: "openai" }));
    expect(res.status).toBe(200);
  });

  it("DELETE with an invalid provider → 400 + warn", async () => {
    const res = await aiDelete(deleteReq({ provider: "gemini" }));
    expect(res.status).toBe(400);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "ai:credentials-delete-validation-failed",
    );
  });
});
