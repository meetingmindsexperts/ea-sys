import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAuth, mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    promoCode: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    promoCodeTicketType: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
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
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user: { role: string } }) =>
    ["REVIEWER", "SUBMITTER", "REGISTRANT"].includes(session.user.role)
      ? { status: 403, json: async () => ({ error: "Forbidden" }) }
      : null,
}));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: vi.fn((user: { organizationId: string }, eventId: string) => ({
    id: eventId,
    organizationId: user.organizationId,
  })),
}));

// Import routes AFTER mocks
import { GET as ListPromoCodes, POST as CreatePromoCode } from "@/app/api/events/[eventId]/promo-codes/route";
import {
  GET as GetPromoCode,
  PUT as UpdatePromoCode,
  DELETE as DeletePromoCode,
} from "@/app/api/events/[eventId]/promo-codes/[promoCodeId]/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeListParams(eventId: string) {
  return { params: Promise.resolve({ eventId }) };
}

function makeDetailParams(eventId: string, promoCodeId: string) {
  return { params: Promise.resolve({ eventId, promoCodeId }) };
}

function makeRequest(method: string, body?: unknown) {
  return new Request("http://localhost/api/events/evt-1/promo-codes", {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

const adminSession = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const reviewerSession = { user: { id: "rev-1", role: "REVIEWER", organizationId: null } };

const samplePromoCode = {
  id: "promo-1",
  eventId: "evt-1",
  code: "EARLYBIRD20",
  description: "20% early bird discount",
  discountType: "PERCENTAGE",
  discountValue: 20,
  currency: null,
  maxUses: 100,
  maxUsesPerEmail: 1,
  usedCount: 5,
  validFrom: null,
  validUntil: null,
  isActive: true,
  createdAt: new Date().toISOString(),
  ticketTypes: [],
  _count: { redemptions: 5 },
};

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/events/[eventId]/promo-codes", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await ListPromoCodes(makeRequest("GET"), makeListParams("evt-1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when event not found", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(null);
    mockDb.promoCode.findMany.mockResolvedValue([]);
    const res = await ListPromoCodes(makeRequest("GET"), makeListParams("evt-1"));
    expect(res.status).toBe(404);
  });

  it("returns promo codes list for valid admin", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.promoCode.findMany.mockResolvedValue([samplePromoCode]);
    const res = await ListPromoCodes(makeRequest("GET"), makeListParams("evt-1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].code).toBe("EARLYBIRD20");
  });
});

describe("POST /api/events/[eventId]/promo-codes", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await CreatePromoCode(
      makeRequest("POST", { code: "TEST", discountType: "PERCENTAGE", discountValue: 10 }),
      makeListParams("evt-1"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 for REVIEWER role", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const res = await CreatePromoCode(
      makeRequest("POST", { code: "TEST", discountType: "PERCENTAGE", discountValue: 10 }),
      makeListParams("evt-1"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid input (missing code)", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const res = await CreatePromoCode(
      makeRequest("POST", { discountType: "PERCENTAGE", discountValue: 10 }),
      makeListParams("evt-1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when percentage > 100", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const res = await CreatePromoCode(
      makeRequest("POST", { code: "BAD", discountType: "PERCENTAGE", discountValue: 150 }),
      makeListParams("evt-1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when FIXED_AMOUNT has no currency", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const res = await CreatePromoCode(
      makeRequest("POST", { code: "FIXED", discountType: "FIXED_AMOUNT", discountValue: 50 }),
      makeListParams("evt-1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 for duplicate code", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.promoCode.findUnique.mockResolvedValue({ id: "existing" });
    const res = await CreatePromoCode(
      makeRequest("POST", { code: "DUPE", discountType: "PERCENTAGE", discountValue: 10 }),
      makeListParams("evt-1"),
    );
    expect(res.status).toBe(409);
  });

  it("creates promo code with valid input", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.promoCode.findUnique.mockResolvedValue(null);
    mockDb.promoCode.create.mockResolvedValue({ ...samplePromoCode, code: "NEWCODE" });
    const res = await CreatePromoCode(
      makeRequest("POST", {
        code: "newcode",
        discountType: "PERCENTAGE",
        discountValue: 20,
        maxUses: 100,
      }),
      makeListParams("evt-1"),
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.code).toBe("NEWCODE");
  });

  it("uppercases the code on creation", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.promoCode.findUnique.mockResolvedValue(null);
    mockDb.promoCode.create.mockResolvedValue(samplePromoCode);
    await CreatePromoCode(
      makeRequest("POST", { code: "lowercase", discountType: "PERCENTAGE", discountValue: 10 }),
      makeListParams("evt-1"),
    );
    const createCall = mockDb.promoCode.create.mock.calls[0][0];
    expect(createCall.data.code).toBe("LOWERCASE");
  });

  it("creates with ticket type restrictions", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.promoCode.findUnique.mockResolvedValue(null);
    mockDb.promoCode.create.mockResolvedValue(samplePromoCode);
    await CreatePromoCode(
      makeRequest("POST", {
        code: "VIP",
        discountType: "PERCENTAGE",
        discountValue: 50,
        ticketTypeIds: ["tt-1", "tt-2"],
      }),
      makeListParams("evt-1"),
    );
    const createCall = mockDb.promoCode.create.mock.calls[0][0];
    expect(createCall.data.ticketTypes.create).toHaveLength(2);
  });
});

describe("GET /api/events/[eventId]/promo-codes/[promoCodeId]", () => {
  it("returns 404 when promo code not found", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.promoCode.findFirst.mockResolvedValue(null);
    const res = await GetPromoCode(
      makeRequest("GET"),
      makeDetailParams("evt-1", "promo-999"),
    );
    expect(res.status).toBe(404);
  });

  it("returns promo code with redemption history", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.promoCode.findFirst.mockResolvedValue({
      ...samplePromoCode,
      redemptions: [{ id: "r1", email: "test@example.com", discountAmount: 100, createdAt: new Date() }],
    });
    const res = await GetPromoCode(
      makeRequest("GET"),
      makeDetailParams("evt-1", "promo-1"),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.redemptions).toHaveLength(1);
  });
});

describe("DELETE /api/events/[eventId]/promo-codes/[promoCodeId]", () => {
  it("returns 403 for REVIEWER role", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const res = await DeletePromoCode(
      makeRequest("DELETE"),
      makeDetailParams("evt-1", "promo-1"),
    );
    expect(res.status).toBe(403);
  });

  it("soft-deletes (deactivates) when code has redemptions", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.promoCode.findFirst.mockResolvedValue({
      id: "promo-1",
      code: "USED",
      _count: { redemptions: 3 },
    });
    mockDb.promoCode.update.mockResolvedValue({ id: "promo-1", isActive: false });
    const res = await DeletePromoCode(
      makeRequest("DELETE"),
      makeDetailParams("evt-1", "promo-1"),
    );
    expect(res.status).toBe(200);
    expect(mockDb.promoCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } }),
    );
    expect(mockDb.promoCode.delete).not.toHaveBeenCalled();
  });

  it("hard-deletes when code has no redemptions", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.promoCode.findFirst.mockResolvedValue({
      id: "promo-1",
      code: "UNUSED",
      _count: { redemptions: 0 },
    });
    mockDb.promoCode.delete.mockResolvedValue({ id: "promo-1" });
    const res = await DeletePromoCode(
      makeRequest("DELETE"),
      makeDetailParams("evt-1", "promo-1"),
    );
    expect(res.status).toBe(200);
    expect(mockDb.promoCode.delete).toHaveBeenCalled();
    expect(mockDb.promoCode.update).not.toHaveBeenCalled();
  });
});

describe("PUT /api/events/[eventId]/promo-codes/[promoCodeId]", () => {
  it("returns 409 when changing to a duplicate code", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.promoCode.findFirst
      .mockResolvedValueOnce({ id: "promo-1" }) // existing promo
      .mockResolvedValueOnce({ id: "promo-2" }); // duplicate check
    const res = await UpdatePromoCode(
      makeRequest("PUT", { code: "EXISTING" }),
      makeDetailParams("evt-1", "promo-1"),
    );
    expect(res.status).toBe(409);
  });

  it("updates promo code fields", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.promoCode.findFirst
      .mockResolvedValueOnce({ id: "promo-1" }) // existing
      .mockResolvedValueOnce(null); // no duplicate
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
    mockDb.promoCode.update.mockResolvedValue({ ...samplePromoCode, discountValue: 30 });
    const res = await UpdatePromoCode(
      makeRequest("PUT", { discountValue: 30 }),
      makeDetailParams("evt-1", "promo-1"),
    );
    expect(res.status).toBe(200);
  });
});
