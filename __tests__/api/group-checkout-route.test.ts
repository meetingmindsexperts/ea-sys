/**
 * Group card checkout (group registration Phase 2) — the door.
 *
 * The properties that matter here are financial, not procedural: the company
 * must be charged EXACTLY what its consolidated invoice says, the Stripe page
 * must never show line items that don't add up to their own total, and a
 * group that settled while the tab was open must not be charged twice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, sessionsCreate, sessionsExpire } = vi.hoisted(() => ({
  mockDb: {
    registrationGroup: { findFirst: vi.fn() },
    invoice: { findFirst: vi.fn() },
    registration: { updateMany: vi.fn() },
  },
  sessionsCreate: vi.fn(),
  sessionsExpire: vi.fn().mockResolvedValue({}),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({
      status: i?.status ?? 200,
      json: async () => b,
      headers: { get: () => null, set: () => {} },
    }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/public-event", () => ({
  publicEventWhere: vi.fn(async (_req: unknown, slug: string) => ({ slug })),
}));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/tenant/resolver", () => ({
  resolveTenantOrg: vi.fn(async () => ({ orgId: "org1" })),
  normalizeHost: (h: string | null) => h ?? "",
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(async () => ({
    checkout: { sessions: { create: sessionsCreate, expire: sessionsExpire } },
  })),
  isZeroDecimalCurrency: (c: string) => ["jpy", "krw"].includes(c.toLowerCase()),
}));

import { POST } from "@/app/api/public/events/[slug]/group-checkout/route";

const params = { params: Promise.resolve({ slug: "BIGSKY2027" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api/public/events/BIGSKY2027/group-checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const member = (price: number, type: string, status = "UNPAID") => ({
  id: `reg-${Math.random()}`,
  paymentStatus: status,
  originalPrice: price,
  ticketType: { name: type, currency: "USD" },
  pricingTier: null,
});

const GROUP = {
  id: "grp-1",
  coordinatorEmail: "layla@corp.com",
  event: {
    id: "ev1",
    name: "BigSky 2027",
    slug: "BIGSKY2027",
    organizationId: "org1",
    taxRate: 5,
    taxLabel: "VAT",
  },
  billingAccount: { name: "Gulf Heart Institute", email: "finance@corp.com" },
  registrations: [member(100, "Physician"), member(100, "Physician"), member(150, "Allied Health")],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registrationGroup.findFirst.mockResolvedValue(GROUP);
  mockDb.invoice.findFirst.mockResolvedValue({
    id: "inv-1",
    subtotal: 350,
    taxAmount: 17.5,
    total: 367.5,
    currency: "USD",
  });
  mockDb.registration.updateMany.mockResolvedValue({ count: 3 });
  sessionsCreate.mockResolvedValue({ id: "cs_grp_1", url: "https://stripe.test/pay" });
});

describe("group checkout — amount", () => {
  it("returns a checkout URL for a payable group", async () => {
    const res = await POST(req({ groupId: "grp-1" }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checkoutUrl: "https://stripe.test/pay" });

    const charged = sessionsCreate.mock.calls[0][0].line_items.reduce(
      (s: number, li: { price_data: { unit_amount: number } }) => s + li.price_data.unit_amount,
      0,
    );
    expect(charged).toBe(36750); // 367.50 in minor units
  });

  it("charges the INVOICE snapshot even when live members now total something else", async () => {
    // Deliberately DIVERGENT fixture: the frozen invoice says 350 + 17.50 VAT
    // while the surviving members total 100. Charging the members would be
    // 105.00 — a card statement that contradicts the document the company was
    // sent. This is the assertion that fails if anyone "simplifies" the route
    // into recomputing from live rows.
    mockDb.registrationGroup.findFirst.mockResolvedValue({
      ...GROUP,
      registrations: [member(100, "Physician")],
    });
    await POST(req({ groupId: "grp-1" }), params);

    const charged = sessionsCreate.mock.calls[0][0].line_items.reduce(
      (s: number, li: { price_data: { unit_amount: number } }) => s + li.price_data.unit_amount,
      0,
    );
    expect(charged).toBe(36750);
    expect(charged).not.toBe(10500);
  });

  it("groups line items by registration type when they reconcile", async () => {
    await POST(req({ groupId: "grp-1" }), params);
    const names = sessionsCreate.mock.calls[0][0].line_items.map(
      (li: { price_data: { product_data: { name: string } } }) => li.price_data.product_data.name,
    );
    expect(names.some((n: string) => n.includes("2 × Physician"))).toBe(true);
    expect(names.some((n: string) => n.includes("1 × Allied Health"))).toBe(true);
    expect(names.some((n: string) => n.includes("VAT"))).toBe(true);
  });

  it("falls back to one honest line when a cancellation made the lines stop adding up", async () => {
    // Invoice frozen at 350 but only one 100 member survives → derived lines
    // would total 100 against a 367.50 charge.
    mockDb.registrationGroup.findFirst.mockResolvedValue({
      ...GROUP,
      registrations: [member(100, "Physician")],
    });
    await POST(req({ groupId: "grp-1" }), params);
    const lineItems = sessionsCreate.mock.calls[0][0].line_items;
    const names = lineItems.map(
      (li: { price_data: { product_data: { name: string } } }) => li.price_data.product_data.name,
    );
    expect(names.some((n: string) => n.includes("group registration"))).toBe(true);
    expect(names.some((n: string) => n.includes("× Physician"))).toBe(false);
    const charged = lineItems.reduce(
      (s: number, li: { price_data: { unit_amount: number } }) => s + li.price_data.unit_amount,
      0,
    );
    expect(charged).toBe(36750);
  });

  it("computes from members when no invoice exists (invoice creation is failure-isolated)", async () => {
    mockDb.invoice.findFirst.mockResolvedValue(null);
    await POST(req({ groupId: "grp-1" }), params);
    const charged = sessionsCreate.mock.calls[0][0].line_items.reduce(
      (s: number, li: { price_data: { unit_amount: number } }) => s + li.price_data.unit_amount,
      0,
    );
    expect(charged).toBe(36750); // 350 + 5% VAT
  });
});

describe("group checkout — guards", () => {
  it("bills the company's finance contact, not the coordinator, when there is one", async () => {
    await POST(req({ groupId: "grp-1" }), params);
    expect(sessionsCreate.mock.calls[0][0].customer_email).toBe("finance@corp.com");
  });

  it("carries groupId + org on the session so the webhook can settle it", async () => {
    await POST(req({ groupId: "grp-1" }), params);
    expect(sessionsCreate.mock.calls[0][0].metadata).toMatchObject({
      groupId: "grp-1",
      eventId: "ev1",
      organizationId: "org1",
    });
  });

  it("refuses when nothing is due — never opens a second charge on a paid group", async () => {
    mockDb.registrationGroup.findFirst.mockResolvedValue({
      ...GROUP,
      registrations: GROUP.registrations.map((r) => ({ ...r, paymentStatus: "PAID" })),
    });
    const res = await POST(req({ groupId: "grp-1" }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "ALREADY_SETTLED" });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("expires the session it just created if the group settled mid-flight", async () => {
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(req({ groupId: "grp-1" }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "ALREADY_SETTLED" });
    // The stale payment link must not stay live.
    expect(sessionsExpire).toHaveBeenCalledWith("cs_grp_1");
  });

  it("claims only payable members, so a concurrent settlement isn't demoted", async () => {
    await POST(req({ groupId: "grp-1" }), params);
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: {
        groupId: "grp-1",
        status: { not: "CANCELLED" },
        paymentStatus: { in: ["UNPAID", "PENDING"] },
      },
      data: { paymentStatus: "PENDING", stripeCheckoutSessionId: "cs_grp_1" },
    });
  });

  it("404s an unknown or cross-event group", async () => {
    mockDb.registrationGroup.findFirst.mockResolvedValue(null);
    const res = await POST(req({ groupId: "nope" }), params);
    expect(res.status).toBe(404);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const res = await POST(req({}), params);
    expect(res.status).toBe(400);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("refuses a zero-total group rather than opening an empty charge", async () => {
    mockDb.invoice.findFirst.mockResolvedValue(null);
    mockDb.registrationGroup.findFirst.mockResolvedValue({
      ...GROUP,
      event: { ...GROUP.event, taxRate: 0 },
      registrations: [member(0, "Complimentary")],
    });
    const res = await POST(req({ groupId: "grp-1" }), params);
    expect(res.status).toBe(400);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});
