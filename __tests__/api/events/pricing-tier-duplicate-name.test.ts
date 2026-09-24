/**
 * A pricing tier name is unique per registration type. The routes check first
 * and answer 409; two saves with the same name can both pass that check (a
 * double submit, seen on prod Sep 24 2026), and the unique index refuses the
 * second. That refusal is the same answer, so it must be a 409 with a warn,
 * not a 500 logged as an error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockAuth, mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    ticketType: { findFirst: vi.fn() },
    pricingTier: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: { set: vi.fn() } }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth-guards", () => ({ WEBINAR_STAFF_ALLOW: ["WEBINARS"], denyReviewer: () => null }));

import { POST as CreateTier } from "@/app/api/events/[eventId]/tickets/[ticketId]/tiers/route";
import { PUT as UpdateTier } from "@/app/api/events/[eventId]/tickets/[ticketId]/tiers/[tierId]/route";

const session = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const req = (method: string, body: unknown) => new Request("http://localhost/api/x", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`ticketTypeId`,`name`)", { code: "P2002", clientVersion: "6.19.3", meta: { modelName: "PricingTier", target: ["ticketTypeId", "name"] } });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev-1" });
  mockDb.ticketType.findFirst.mockResolvedValue({ id: "tt-1" });
  mockDb.pricingTier.findFirst.mockResolvedValue(null);
  mockDb.pricingTier.count.mockResolvedValue(2);
});

describe("POST tiers: a duplicate name", () => {
  const params = { params: Promise.resolve({ eventId: "ev-1", ticketId: "tt-1" }) };
  it("found by the check is a 409 and logs a warn", async () => {
    mockDb.pricingTier.findFirst.mockResolvedValueOnce({ id: "tier-1" });
    const res = await CreateTier(req("POST", { name: "Presenter Standard", price: 100 }), params);
    expect(res.status).toBe(409);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "pricing-tier:create-duplicate-name" }));
    expect(mockDb.pricingTier.create).not.toHaveBeenCalled();
  });
  it("that slips past the check and hits the unique index is still a 409, a warn and no error", async () => {
    mockDb.pricingTier.create.mockRejectedValueOnce(uniqueViolation());
    const res = await CreateTier(req("POST", { name: "Presenter Standard", price: 100 }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already exists/);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "pricing-tier:create-duplicate-name-race" }));
    expect(mockApiLogger.error).not.toHaveBeenCalled();
  });
  it("any other database failure is still a 500 logged as an error", async () => {
    mockDb.pricingTier.create.mockRejectedValueOnce(new Error("connection reset"));
    const res = await CreateTier(req("POST", { name: "Onsite", price: 100 }), params);
    expect(res.status).toBe(500);
    expect(mockApiLogger.error).toHaveBeenCalled();
  });
});

describe("PUT tier: a rename onto a name already taken", () => {
  const params = { params: Promise.resolve({ eventId: "ev-1", ticketId: "tt-1", tierId: "tier-2" }) };
  beforeEach(() => {
    mockDb.pricingTier.findFirst.mockReset();
    mockDb.pricingTier.findFirst.mockResolvedValueOnce({ id: "tier-2", name: "Early Bird" }).mockResolvedValue(null);
  });
  it("found by the check is a 409 and logs a warn", async () => {
    mockDb.pricingTier.findFirst.mockReset();
    mockDb.pricingTier.findFirst.mockResolvedValueOnce({ id: "tier-2", name: "Early Bird" }).mockResolvedValueOnce({ id: "tier-1" });
    const res = await UpdateTier(req("PUT", { name: "Standard" }), params);
    expect(res.status).toBe(409);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "pricing-tier:rename-duplicate-name" }));
    expect(mockDb.pricingTier.update).not.toHaveBeenCalled();
  });
  it("that slips past the check and hits the unique index is still a 409, a warn and no error", async () => {
    mockDb.pricingTier.update.mockRejectedValueOnce(uniqueViolation());
    const res = await UpdateTier(req("PUT", { name: "Standard" }), params);
    expect(res.status).toBe(409);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "pricing-tier:rename-duplicate-name-race" }));
    expect(mockApiLogger.error).not.toHaveBeenCalled();
  });
});
