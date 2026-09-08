/**
 * Public registration honours the registration TYPE's seat limit as the
 * ceiling over its pricing tiers (owner decision Sep 8, 2026).
 *
 * The failure this pins: a type limited to 35 with an unlimited "Standard"
 * tier took 107 public registrations, because the route's capacity source was
 * `pricingTier || ticketType` and the type's limit was never read on a tier
 * sale. The early (non-authoritative) check now refuses when EITHER limit is
 * reached; the authoritative claim inside the transaction goes through the
 * shared `claimSeats`, which is pinned in __tests__/lib/type-seat-ceiling.
 *
 * Mock pattern copied from supporting-document-gate.test.ts: reaching the
 * transaction is signalled by a sentinel throw, so the test stays about the
 * gate and never mocks the whole create path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockTenantTransaction } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    ticketType: { findFirst: vi.fn() },
    pricingTier: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockTenantTransaction: vi.fn(async () => {
    throw new Error("__REACHED_TRANSACTION__");
  }),
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
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb, tenantTransaction: mockTenantTransaction }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere: vi.fn(async () => ({})) }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/utils", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateBarcode: () => "BC123",
}));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: vi.fn(async () => 1) }));
vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: vi.fn() }));
vi.mock("@/lib/webinar-email-sequence", () => ({ sendWebinarConfirmationForRegistration: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/registrant-account", () => ({ ensureRegistrantAccount: vi.fn() }));
vi.mock("@/lib/registration-seat-db", () => ({
  claimEventSeats: vi.fn(async () => true),
  claimSeats: vi.fn(async () => true),
}));
vi.mock("@/lib/registration-confirmation", () => ({ buildEventConfirmationFields: () => ({}) }));

import { POST } from "@/app/api/public/events/[slug]/register/route";

const params = Promise.resolve({ slug: "oopvf" });

function request(extra: Record<string, unknown> = {}) {
  return new Request("http://t", {
    method: "POST",
    body: JSON.stringify({
      ticketTypeId: "tt-delegate",
      pricingTierId: "pt-standard",
      title: "DR",
      role: "PHYSICIAN",
      firstName: "Ahmed",
      lastName: "Osman",
      email: "ahmed@hospital.org",
      organization: "Royal Hospital",
      jobTitle: "Pharmacist",
      phone: "+96890000000",
      city: "Muscat",
      country: "Oman",
      specialty: "Oncology",
      ...extra,
    }),
  });
}

async function run(typeSoldCount: number, tierSoldCount = typeSoldCount) {
  mockDb.ticketType.findFirst.mockResolvedValue({
    id: "tt-delegate",
    name: "Delegate",
    price: 0,
    currency: "USD",
    quantity: 35, // the organiser's limit on the TYPE
    soldCount: typeSoldCount,
    isFaculty: false,
    requiresApproval: false,
    salesStart: null,
    salesEnd: null,
  });
  mockDb.pricingTier.findFirst.mockResolvedValue({
    id: "pt-standard",
    name: "Standard",
    price: 0,
    currency: "USD",
    quantity: 999999, // the tier itself is unlimited: the Oman shape
    soldCount: tierSoldCount,
    requiresApproval: false,
    salesStart: null,
    salesEnd: null,
    isActive: true,
  });
  let status: number | undefined;
  let body: { error?: string } | undefined;
  let reachedTransaction = false;
  try {
    const res = await POST(request(), { params });
    status = res.status;
    body = await res.json();
  } catch (err) {
    if ((err as Error).message === "__REACHED_TRANSACTION__") reachedTransaction = true;
    else throw err;
  }
  if (status === 500) reachedTransaction = true;
  return { status, error: body?.error, reachedTransaction };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantTransaction.mockImplementation(async () => {
    throw new Error("__REACHED_TRANSACTION__");
  });
  mockDb.event.findFirst.mockResolvedValue({
    id: "evt-1",
    slug: "oopvf",
    name: "Oman Oncology Pharmacy Value Forum 2026",
    status: "PUBLISHED",
    eventType: "CONFERENCE",
    organizationId: "org-1",
    settings: {},
    maxAttendees: null,
    seatCount: 0,
    startDate: new Date("2026-09-12T04:00:00Z"),
    endDate: new Date("2026-09-12T14:00:00Z"),
    timezone: "Asia/Muscat",
    taxRate: null,
    ticketTypes: [],
  });
  mockDb.registration.findFirst.mockResolvedValue(null);
});

describe("public register — the type limit is the ceiling over an unlimited tier", () => {
  it("refuses a tier sale once the TYPE is full, even though the tier has room", async () => {
    const r = await run(35);
    expect(r.reachedTransaction).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toBe("Sold out");
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "public/register:sold-out", ticketTypeId: "tt-delegate", pricingTierId: "pt-standard" }),
    );
  });

  it("refuses when the type is OVER its limit (the counter healed after the fact)", async () => {
    const r = await run(107);
    expect(r.status).toBe(400);
    expect(r.error).toBe("Sold out");
  });

  it("lets a tier sale through while the type still has room", async () => {
    const r = await run(34);
    expect(r.reachedTransaction).toBe(true);
    expect(mockApiLogger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ msg: "public/register:sold-out" }),
    );
  });
});
