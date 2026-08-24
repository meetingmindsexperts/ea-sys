/**
 * Per-org Stripe webhook route /api/webhooks/stripe/[orgId] — the hardened
 * verification shell (Aug 4 review: HIGH-1 / M2 / M3 / L6) around the SHARED
 * dispatcher:
 *   - per-IP rate limit BEFORE the DB read (M3)
 *   - org's webhook secret via getOrgStripeWebhookSecret
 *   - ONE generic 400 body for every refusal — missing secret, bad signature,
 *     livemode mismatch, foreign metadata — no config-state oracle (L6)
 *   - livemode must match the stored keyMode (M2)
 *   - metadata claiming another org is REJECTED (HIGH-1 first layer)
 *   - verified events delegate with { expectedOrgId } so the dispatcher
 *     enforces the resolved org (HIGH-1 second layer — pinned in the
 *     dispatcher suite)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

const { mockApiLogger, mockGetOrgSecret, mockConstructEvent, mockHandleEvent, mockCheckRateLimit } = vi.hoisted(() => ({
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockGetOrgSecret: vi.fn(),
  mockConstructEvent: vi.fn(),
  mockHandleEvent: vi.fn(),
  mockCheckRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/stripe", () => ({
  // Signature verification no longer routes through getStripe (Aug 24,
  // 2026): it is static crypto and must not depend on a resolvable API
  // key. Same underlying spy, so existing expectations still hold.
  verifyWebhookSignature: vi.fn((body: unknown, sig: string, secret: string) =>
    mockConstructEvent(body, sig, secret),
  ),
  getStripe: vi.fn(async () => ({ webhooks: { constructEvent: mockConstructEvent } })),
  getOrgStripeWebhookSecret: mockGetOrgSecret,
}));
vi.mock("@/lib/stripe-webhook-handler", () => ({ handleStripeEvent: mockHandleEvent }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: mockCheckRateLimit,
  getClientIp: () => "203.0.113.9",
}));

import { POST } from "@/app/api/webhooks/stripe/[orgId]/route";

const ORG = "org_tenant_1";
const GENERIC_BODY = { error: "Webhook request rejected" };

function makeReq(body = "{}", sig: string | null = "t=1,v1=abc") {
  const headers = new Headers();
  if (sig) headers.set("stripe-signature", sig);
  return new Request(`http://localhost/api/webhooks/stripe/${ORG}`, {
    method: "POST",
    headers,
    body,
  });
}

function callRoute(req: Request, orgId = ORG) {
  return POST(req, { params: Promise.resolve({ orgId }) });
}

function liveSecret() {
  mockGetOrgSecret.mockResolvedValue({ webhookSecret: "whsec_org", keyMode: "live" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockHandleEvent.mockResolvedValue(NextResponse.json({ received: true }));
});

describe("POST /api/webhooks/stripe/[orgId]", () => {
  it("rate limited → 429 + Retry-After, BEFORE any secret read (M3)", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 30 });
    const res = await callRoute(makeReq());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(mockGetOrgSecret).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "stripe-org-webhook:rate-limited" }),
    );
  });

  it("missing signature header → generic 400 + warn", async () => {
    const res = await callRoute(makeReq("{}", null));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(GENERIC_BODY);
    expect(mockHandleEvent).not.toHaveBeenCalled();
  });

  it("org without a configured webhook secret → the SAME generic 400 (no oracle, L6)", async () => {
    mockGetOrgSecret.mockResolvedValue(null);
    const res = await callRoute(makeReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(GENERIC_BODY);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "stripe-org-webhook:secret-not-configured", orgId: ORG }),
    );
  });

  it("bad signature → the SAME generic 400 body as unconfigured (L6)", async () => {
    liveSecret();
    mockConstructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature");
    });
    const res = await callRoute(makeReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(GENERIC_BODY);
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "stripe-org-webhook:signature-verification-failed", orgId: ORG }),
    );
    expect(mockHandleEvent).not.toHaveBeenCalled();
  });

  it("TEST-mode event on a LIVE-keyed org → refused (M2 — fake money can't flip real registrations)", async () => {
    liveSecret();
    mockConstructEvent.mockReturnValue({ type: "checkout.session.completed", livemode: false, data: { object: {} } });
    const res = await callRoute(makeReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(GENERIC_BODY);
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "stripe-org-webhook:livemode-mismatch-refused", keyMode: "live" }),
    );
    expect(mockHandleEvent).not.toHaveBeenCalled();
  });

  it("keyMode null (no API key saved) skips the livemode check", async () => {
    mockGetOrgSecret.mockResolvedValue({ webhookSecret: "whsec_org", keyMode: null });
    mockConstructEvent.mockReturnValue({ type: "checkout.session.completed", livemode: false, data: { object: {} } });
    const res = await callRoute(makeReq());
    expect(res.status).toBe(200);
    expect(mockHandleEvent).toHaveBeenCalled();
  });

  it("metadata claiming ANOTHER org → REJECTED with the generic 400 (HIGH-1 first layer)", async () => {
    liveSecret();
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      livemode: true,
      data: { object: { metadata: { organizationId: "org_other" } } },
    });
    const res = await callRoute(makeReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(GENERIC_BODY);
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "stripe-org-webhook:metadata-org-mismatch-refused",
        orgId: ORG,
        metadataOrganizationId: "org_other",
      }),
    );
    expect(mockHandleEvent).not.toHaveBeenCalled();
  });

  it("verified matching event → constructEvent gets the ORG secret and delegates WITH expectedOrgId (HIGH-1 second layer)", async () => {
    liveSecret();
    const fakeEvent = {
      type: "checkout.session.completed",
      livemode: true,
      data: { object: { metadata: { organizationId: ORG } } },
    };
    mockConstructEvent.mockReturnValue(fakeEvent);
    const res = await callRoute(makeReq("raw-body"));
    expect(res.status).toBe(200);
    expect(mockConstructEvent).toHaveBeenCalledWith("raw-body", "t=1,v1=abc", "whsec_org");
    expect(mockHandleEvent).toHaveBeenCalledWith(fakeEvent, { expectedOrgId: ORG });
  });

  it("event with NO org metadata still delegates with expectedOrgId (the dispatcher enforces the resolved org)", async () => {
    liveSecret();
    const fakeEvent = { type: "charge.refunded", livemode: true, data: { object: {} } };
    mockConstructEvent.mockReturnValue(fakeEvent);
    const res = await callRoute(makeReq());
    expect(res.status).toBe(200);
    expect(mockHandleEvent).toHaveBeenCalledWith(fakeEvent, { expectedOrgId: ORG });
  });
});
