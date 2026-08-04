/**
 * Per-org Stripe webhook route /api/webhooks/stripe/[orgId] — the
 * verification shell around the SHARED dispatcher:
 *   - org's webhook secret resolved via getOrgStripeWebhookSecret
 *   - unknown org / unconfigured secret → the SAME generic 400 (no oracle)
 *   - bad signature → 400 + log
 *   - verified event → delegated to handleStripeEvent (the one implementation
 *     the legacy route also uses — drift is structurally impossible)
 *   - metadata org mismatch → warn log, NOT a rejection
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

const { mockApiLogger, mockGetOrgSecret, mockConstructEvent, mockHandleEvent } = vi.hoisted(() => ({
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockGetOrgSecret: vi.fn(),
  mockConstructEvent: vi.fn(),
  mockHandleEvent: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(async () => ({ webhooks: { constructEvent: mockConstructEvent } })),
  getOrgStripeWebhookSecret: mockGetOrgSecret,
}));
vi.mock("@/lib/stripe-webhook-handler", () => ({ handleStripeEvent: mockHandleEvent }));

import { POST } from "@/app/api/webhooks/stripe/[orgId]/route";

const ORG = "org_tenant_1";

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

beforeEach(() => {
  vi.clearAllMocks();
  mockHandleEvent.mockResolvedValue(NextResponse.json({ received: true }));
});

describe("POST /api/webhooks/stripe/[orgId]", () => {
  it("missing signature header → 400 + warn", async () => {
    const res = await callRoute(makeReq("{}", null));
    expect(res.status).toBe(400);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "stripe-org-webhook:missing-signature-header", orgId: ORG }),
    );
    expect(mockHandleEvent).not.toHaveBeenCalled();
  });

  it("org without a configured webhook secret → generic 400 + warn (no org oracle)", async () => {
    mockGetOrgSecret.mockResolvedValue(null);
    const res = await callRoute(makeReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Webhook not configured" });
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "stripe-org-webhook:secret-not-configured", orgId: ORG }),
    );
    expect(mockHandleEvent).not.toHaveBeenCalled();
  });

  it("unknown org → the SAME generic 400 body as unconfigured", async () => {
    mockGetOrgSecret.mockResolvedValue(null);
    const res = await callRoute(makeReq(), "org_does_not_exist");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Webhook not configured" });
  });

  it("bad signature → 400 + error log", async () => {
    mockGetOrgSecret.mockResolvedValue("whsec_org");
    mockConstructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature");
    });
    const res = await callRoute(makeReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid signature" });
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "stripe-org-webhook:signature-verification-failed", orgId: ORG }),
    );
    expect(mockHandleEvent).not.toHaveBeenCalled();
  });

  it("verified event → constructEvent gets the ORG secret and the event delegates to the shared handler", async () => {
    mockGetOrgSecret.mockResolvedValue("whsec_org");
    const fakeEvent = { type: "checkout.session.completed", data: { object: { metadata: { organizationId: ORG } } } };
    mockConstructEvent.mockReturnValue(fakeEvent);
    const res = await callRoute(makeReq("raw-body"));
    expect(res.status).toBe(200);
    expect(mockConstructEvent).toHaveBeenCalledWith("raw-body", "t=1,v1=abc", "whsec_org");
    expect(mockHandleEvent).toHaveBeenCalledWith(fakeEvent);
    expect(mockApiLogger.warn).not.toHaveBeenCalled();
  });

  it("metadata org mismatch → warn log but the event is STILL processed (signature already proved ownership)", async () => {
    mockGetOrgSecret.mockResolvedValue("whsec_org");
    const fakeEvent = { type: "checkout.session.completed", data: { object: { metadata: { organizationId: "org_other" } } } };
    mockConstructEvent.mockReturnValue(fakeEvent);
    const res = await callRoute(makeReq());
    expect(res.status).toBe(200);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "stripe-org-webhook:metadata-org-mismatch",
        orgId: ORG,
        metadataOrganizationId: "org_other",
      }),
    );
    expect(mockHandleEvent).toHaveBeenCalledWith(fakeEvent);
  });
});
