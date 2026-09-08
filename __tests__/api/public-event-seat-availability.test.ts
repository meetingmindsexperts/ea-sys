/**
 * The public event payload's per-tier availability is bounded by the ticket
 * TYPE's limit as well as the tier's own (Sep 8, 2026): a tier with 40 seats
 * free under a type with 3 left has 3 available, and `seatLimited` is true
 * for an unlimited tier under a limited type so the form can say "3 seats
 * left" and stop at "Sold out" when the type fills.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    promoCode: { count: vi.fn(async () => 0) },
    eventSession: { findFirst: vi.fn(async () => null) },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: { set: vi.fn() },
    }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere: vi.fn(async () => ({})) }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

import { GET } from "@/app/api/public/events/[slug]/route";

type TierIn = { id: string; name: string; quantity: number; soldCount: number };
function ticketType(id: string, quantity: number, soldCount: number, tiers: TierIn[]) {
  return {
    id,
    name: id,
    description: null,
    isDefault: false,
    sortOrder: 0,
    category: "Standard",
    price: 0,
    virtualPrice: null,
    currency: "USD",
    quantity,
    soldCount,
    maxPerOrder: null,
    salesStart: null,
    salesEnd: null,
    requiresDocument: false,
    documentRequired: false,
    requiresMemberId: false,
    requiresStudentId: false,
    requiresStudentIdExpiry: false,
    documentLabel: null,
    documentInstructions: null,
    pricingTiers: tiers.map((t, i) => ({
      ...t,
      price: 0,
      currency: "USD",
      maxPerOrder: null,
      salesStart: null,
      salesEnd: null,
      requiresApproval: false,
      sortOrder: i,
    })),
  };
}

async function payload(ticketTypes: ReturnType<typeof ticketType>[]) {
  mockDb.event.findFirst
    .mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" }) // scope lookup
    .mockResolvedValueOnce({
      id: "evt-1",
      name: "Oman Oncology Pharmacy Value Forum 2026",
      slug: "oopvf",
      eventType: "CONFERENCE",
      description: null,
      startDate: new Date("2026-09-12T04:00:00Z"),
      endDate: new Date("2026-09-12T14:00:00Z"),
      timezone: "Asia/Muscat",
      venue: null,
      address: null,
      city: "Muscat",
      country: "Oman",
      bannerImage: null,
      bannerImageMobile: null,
      footerHtml: null,
      registrationWelcomeHtml: null,
      registrationTermsHtml: null,
      abstractWelcomeHtml: null,
      sessionProposalWelcomeHtml: null,
      settings: {},
      taxRate: null,
      taxLabel: null,
      maxAttendees: null,
      seatCount: 0,
      organization: { name: "MMG", logo: null },
      ticketTypes,
      tracks: [],
    });
  const res = await GET(new Request("http://t/api/public/events/oopvf"), {
    params: Promise.resolve({ slug: "oopvf" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    ticketTypes: Array<{
      available: number;
      seatLimited: boolean;
      soldOut: boolean;
      pricingTiers: Array<{ id: string; available: number; seatLimited: boolean; soldOut: boolean; canPurchase: boolean }>;
    }>;
  };
}

beforeEach(() => vi.clearAllMocks());

describe("public event API — tier availability is capped by the type's limit", () => {
  it("an unlimited tier under a 35-seat type with 32 sold shows 3 available and is seat-limited", async () => {
    const body = await payload([
      ticketType("Delegate", 35, 32, [
        { id: "pt-standard", name: "Standard", quantity: 999999, soldCount: 32 },
        { id: "pt-eb", name: "Early Bird", quantity: 2, soldCount: 0 },
      ]),
    ]);
    const [type] = body.ticketTypes;
    const standard = type.pricingTiers.find((t) => t.id === "pt-standard")!;
    const earlyBird = type.pricingTiers.find((t) => t.id === "pt-eb")!;
    expect(standard).toMatchObject({ available: 3, seatLimited: true, soldOut: false, canPurchase: true });
    // the tier's own smaller limit still wins when it is the tighter one
    expect(earlyBird).toMatchObject({ available: 2, seatLimited: true, soldOut: false });
    expect(type).toMatchObject({ available: 3, seatLimited: true, soldOut: false });
  });

  it("a type over its limit makes every tier sold out, whatever the tier's own count", async () => {
    const body = await payload([
      ticketType("Delegate", 35, 107, [{ id: "pt-standard", name: "Standard", quantity: 999999, soldCount: 107 }]),
    ]);
    const [type] = body.ticketTypes;
    expect(type.pricingTiers[0]).toMatchObject({ available: -72, soldOut: true, canPurchase: false, seatLimited: true });
    expect(type.soldOut).toBe(true);
  });

  it("no limit anywhere → not seat-limited, availability is the tier's own", async () => {
    const body = await payload([
      ticketType("Physician", 999999, 10, [{ id: "pt-standard", name: "Standard", quantity: 999999, soldCount: 10 }]),
    ]);
    const [type] = body.ticketTypes;
    expect(type.pricingTiers[0]).toMatchObject({ available: 999989, seatLimited: false, soldOut: false });
    expect(type.seatLimited).toBe(false);
  });
});
