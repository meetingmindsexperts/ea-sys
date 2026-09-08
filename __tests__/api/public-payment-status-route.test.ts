/**
 * GET /api/public/events/[slug]/payment-status/[registrationId]
 *
 * The confirmation page's poll. It had NO rate limit until Sep 8, 2026
 * (review P1b): a leaked registration id was an unthrottled payment-status
 * oracle. These pin the limiter's placement (before any DB work), its key and
 * ceiling, the RFC 9110 refusal shape, and that the lane is opened BEFORE the
 * swept Registration read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockCheckRateLimit, mockRunWithTenant, mockWarn } = vi.hoisted(() => ({
  mockDb: { registration: { findFirst: vi.fn() } },
  mockCheckRateLimit: vi.fn(),
  mockRunWithTenant: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/security", () => ({
  getClientIp: vi.fn().mockReturnValue("1.2.3.4"),
  checkRateLimit: (args: unknown) => mockCheckRateLimit(args),
}));
vi.mock("@/lib/tenant/resolver", () => ({
  resolveTenantOrg: vi.fn(async () => ({ orgId: null })),
  normalizeHost: (h: string | null) => h ?? "",
}));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (orgId: string, fn: () => unknown) => mockRunWithTenant(orgId, fn),
}));
vi.mock("@/lib/public-event", () => ({
  publicEventWhere: vi.fn(async (_req: Request, slug: string) => ({ slug })),
}));

import { GET } from "@/app/api/public/events/[slug]/payment-status/[registrationId]/route";

const params = { params: Promise.resolve({ slug: "BHS2026", registrationId: "reg-1" }) };
const req = () => new Request("http://localhost/api/x", { headers: { host: "localhost" } });

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockReturnValue({ allowed: true, remaining: 100, retryAfterSeconds: 900 });
  mockRunWithTenant.mockImplementation((_orgId: string, fn: () => unknown) => fn());
  mockDb.registration.findFirst.mockResolvedValue({
    status: "CONFIRMED",
    serialId: 7,
    paymentStatus: "UNPAID",
    discountAmount: null,
    originalPrice: 100,
    event: { organizationId: "org-1", taxRate: 5, taxLabel: "VAT" },
    ticketType: { name: "Physician", price: 100, currency: "USD" },
    pricingTier: null,
    promoCode: null,
  });
});

describe("GET public payment-status", () => {
  it("refuses with 429 + Retry-After BEFORE touching the database when the limiter says no", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 321 });
    const res = await GET(req(), params);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("321");
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryAfterSeconds).toBe(321);
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ route: "public/payment-status" }));
  });

  it("keys the limiter per IP at 120 per 15 minutes (a silent loosening fails here)", async () => {
    await GET(req(), params);
    expect(mockCheckRateLimit).toHaveBeenCalledWith({
      key: "public-payment-status:1.2.3.4",
      limit: 120,
      windowMs: 15 * 60 * 1000,
    });
  });

  it("opens the tenant lane before the Registration read, and answers with the payment fields", async () => {
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      registrationStatus: "CONFIRMED",
      serialId: 7,
      paymentStatus: "UNPAID",
      ticketName: "Physician",
      ticketPrice: 100,
      taxRate: 5,
    });
    expect(res.headers.get("Cache-Control")).toContain("private");
    // Lane first, read second: a read outside the lane fails closed on the
    // platform (registration.sql is policied).
    const laneCall = mockRunWithTenant.mock.invocationCallOrder[0];
    const readCall = mockDb.registration.findFirst.mock.invocationCallOrder[0];
    expect(laneCall).toBeLessThan(readCall as number);
  });

  it("a miss is a logged 404 (every failure path logs)", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await GET(req(), params);
    expect(res.status).toBe(404);
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ slug: "BHS2026", registrationId: "reg-1" }));
  });
});
