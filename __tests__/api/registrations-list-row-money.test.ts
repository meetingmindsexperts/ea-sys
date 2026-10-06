/**
 * The registrations LIST GET attaches `rowMoney` (collected vs outstanding,
 * from the CSV's own helper) for roles that can see money, and strips it for
 * roles that cannot. The redaction is by key name (FINANCIAL_KEYS), so this
 * pins that the key is actually in the set: a renamed key would silently ship
 * every registration's balance to a REGISTRANT reaching the org-scoped list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockOrgCtx, mockRateLimit } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn(), findFirst: vi.fn() },
    // The surveys each row answered (several surveys, Phase 2).
    surveyResponse: { findMany: vi.fn().mockResolvedValue([]) },
  },
  mockOrgCtx: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock("@/lib/sponsors", () => ({
  getSponsors: vi.fn(async () => []),
  getSponsorNameMap: vi.fn(async () => new Map()),
  sponsorExistsOnEvent: vi.fn(async () => false),
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b, headers: { set: () => {} } }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: () => mockOrgCtx() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null, REGISTRATION_DESK_ALLOW: {} }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: () => mockRateLimit() }));
vi.mock("@/lib/schemas", () => ({ titleEnum: { optional: () => ({}) }, attendeeRoleEnum: { optional: () => ({}) } }));
// Real access + visibility helpers: the point of the test.
vi.mock("@/lib/event-access", async () => await vi.importActual("@/lib/event-access"));
vi.mock("@/lib/finance-visibility", async () => await vi.importActual("@/lib/finance-visibility"));
vi.mock("@/lib/barcode-visibility", async () => await vi.importActual("@/lib/barcode-visibility"));

import { GET as LIST_GET } from "@/app/api/events/[eventId]/registrations/route";

const REGS = [
  {
    id: "r1",
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    originalPrice: 100,
    discountAmount: 0,
    qrCode: "ENTRY-1",
    attendee: { firstName: "A", lastName: "B", country: "Oman" },
    ticketType: { name: "Delegate", currency: "USD", price: 100 },
    payments: [{ status: "PAID", amount: 40 }],
  },
];

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const req = () => new Request("http://localhost/x");

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", taxRate: 5, taxLabel: "VAT", settings: {} });
  mockDb.registration.findMany.mockResolvedValue(REGS.map((r) => ({ ...r, payments: r.payments.map((p) => ({ ...p })) })));
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
});

describe("registrations list rowMoney", () => {
  it("attaches collected + outstanding for an ORGANIZER (100 + 5% VAT, 40 paid)", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: "ORGANIZER", userId: "u1" });
    const body = await (await LIST_GET(req(), params)).json();
    expect(body[0].rowMoney).toEqual({ currency: "USD", totalPaid: 40, fee: 100, amountDue: 65, discount: 0 });
  });

  it("keeps it for MEMBER (finance-capable since the June 17 desk decision)", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: "MEMBER", userId: "m1" });
    const body = await (await LIST_GET(req(), params)).json();
    expect(body[0].rowMoney?.amountDue).toBe(65);
  });

  it("STRIPS it, with the payments, for a role that cannot see money", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: "REGISTRANT", userId: "g1" });
    const body = await (await LIST_GET(req(), params)).json();
    expect("rowMoney" in body[0]).toBe(false);
    expect("payments" in body[0]).toBe(false);
    // Country is not money: it stays.
    expect(body[0].attendee.country).toBe("Oman");
  });
});

describe("sponsor filter follows the redaction (G9, CUSTOM_ROLES_PLAN)", () => {
  const sponsorReq = () => new Request("http://localhost/x?sponsorId=sp1");

  it("lets an API key filter by sponsor, since it receives the field unredacted", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: null, userId: null, fromApiKey: true });
    const res = await LIST_GET(sponsorReq(), params);
    expect(res.status).toBe(200);
    const where = JSON.stringify(mockDb.registration.findMany.mock.calls[0][0].where);
    expect(where).toContain('"sponsorId":"sp1"');
  });

  it("still refuses a role that cannot see finance, before any query", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: "REGISTRANT", userId: "g1" });
    const res = await LIST_GET(sponsorReq(), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "SPONSOR_FILTER_FORBIDDEN" });
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
  });
});

describe("registrations list answeredSurveyIds (several surveys, Phase 2)", () => {
  it("each row carries the surveys it answered, from one read of the event's response rows", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: "ORGANIZER", userId: "u1" });
    mockDb.surveyResponse.findMany.mockResolvedValueOnce([
      { registrationId: "r1", surveyId: "svy-cme" },
      { registrationId: "r1", surveyId: "svy-fb" },
      { registrationId: "someone-else", surveyId: "svy-fb" },
    ]);
    const body = await (await LIST_GET(req(), params)).json();
    expect(body[0].answeredSurveyIds).toEqual(["svy-cme", "svy-fb"]);
    expect(mockDb.surveyResponse.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.surveyResponse.findMany.mock.calls[0][0].where).toEqual({ eventId: "ev1", surveyId: { not: null } });
  });
});
