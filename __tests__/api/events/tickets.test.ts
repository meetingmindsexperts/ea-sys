import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAuth, mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    ticketType: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    pricingTier: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
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
    session.user.role === "REVIEWER" || session.user.role === "SUBMITTER"
      ? { status: 403, json: async () => ({ error: "Forbidden" }) }
      : null,
}));
vi.mock("@/lib/security", () => ({
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

// Import routes AFTER mocks
import { GET as ListTickets, POST as CreateTicket } from "@/app/api/events/[eventId]/tickets/route";
import {
  GET as GetTicket,
  PUT as UpdateTicket,
  DELETE as DeleteTicket,
} from "@/app/api/events/[eventId]/tickets/[ticketId]/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeListParams(eventId: string) {
  return { params: Promise.resolve({ eventId }) };
}

function makeDetailParams(eventId: string, ticketId: string) {
  return { params: Promise.resolve({ eventId, ticketId }) };
}

function makeRequest(method: string, body?: unknown) {
  return new Request("http://localhost/api/events/evt-1/tickets", {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

const adminSession = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const reviewerSession = { user: { id: "rev-1", role: "REVIEWER", organizationId: null } };

const sampleTicketType = {
  id: "tt-1",
  eventId: "evt-1",
  name: "Physician",
  description: null,
  isDefault: true,
  isActive: true,
  sortOrder: 0,
  pricingTiers: [],
  _count: { registrations: 5 },
};

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
});

describe("GET /api/events/[eventId]/tickets", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await ListTickets(makeRequest("GET"), makeListParams("evt-1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when event not found", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(null);
    mockDb.ticketType.findMany.mockResolvedValue([]);
    const res = await ListTickets(makeRequest("GET"), makeListParams("evt-1"));
    expect(res.status).toBe(404);
  });

  it("returns registration types with pricing tiers", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findMany.mockResolvedValue([sampleTicketType]);
    const res = await ListTickets(makeRequest("GET"), makeListParams("evt-1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Physician");
    expect(data[0].pricingTiers).toEqual([]);
  });
});

describe("POST /api/events/[eventId]/tickets", () => {
  it("creates a registration type", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue(null); // no duplicate
    mockDb.ticketType.create.mockResolvedValue({ ...sampleTicketType, id: "tt-new", name: "Society Member" });

    const res = await CreateTicket(
      makeRequest("POST", { name: "Society Member" }),
      makeListParams("evt-1")
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.name).toBe("Society Member");
  });

  it("rejects duplicate name within event", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue({ id: "tt-existing" }); // duplicate exists

    const res = await CreateTicket(
      makeRequest("POST", { name: "Physician" }),
      makeListParams("evt-1")
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain("already exists");
  });

  it("creates with optional pricing tiers", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue(null);
    mockDb.ticketType.create.mockResolvedValue({
      ...sampleTicketType,
      id: "tt-with-tiers",
      pricingTiers: [
        { id: "tier-1", name: "Early Bird", price: 100 },
        { id: "tier-2", name: "Standard", price: 200 },
      ],
    });

    const res = await CreateTicket(
      makeRequest("POST", {
        name: "Physician",
        pricingTiers: [
          { name: "Early Bird", price: 100 },
          { name: "Standard", price: 200 },
        ],
      }),
      makeListParams("evt-1")
    );
    expect(res.status).toBe(201);
  });

  it("rejects reviewer role", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const res = await CreateTicket(
      makeRequest("POST", { name: "Test" }),
      makeListParams("evt-1")
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on invalid input (missing name)", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const res = await CreateTicket(
      makeRequest("POST", {}),
      makeListParams("evt-1")
    );
    expect(res.status).toBe(400);
  });

  it("logs creation with apiLogger.info", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue(null);
    mockDb.ticketType.create.mockResolvedValue({ ...sampleTicketType, id: "tt-log" });

    await CreateTicket(
      makeRequest("POST", { name: "Physician" }),
      makeListParams("evt-1")
    );

    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "Registration type created",
        eventId: "evt-1",
        ticketTypeId: "tt-log",
        name: "Physician",
      })
    );
  });
});

describe("GET /api/events/[eventId]/tickets/[ticketId]", () => {
  it("returns registration type with pricing tiers", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue(sampleTicketType);

    const res = await GetTicket(
      makeRequest("GET"),
      makeDetailParams("evt-1", "tt-1")
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Physician");
  });

  it("returns 404 for non-existent type", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue(null);

    const res = await GetTicket(
      makeRequest("GET"),
      makeDetailParams("evt-1", "tt-missing")
    );
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/events/[eventId]/tickets/[ticketId]", () => {
  it("updates name", async () => {
    mockAuth.mockResolvedValue(adminSession);
    // Promise.all: event findFirst + ticket findFirst
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.ticketType.findFirst
      .mockResolvedValueOnce(sampleTicketType) // existing ticket
      .mockResolvedValueOnce(null); // no duplicate name
    mockDb.ticketType.update.mockResolvedValue({ ...sampleTicketType, name: "Allied Health" });

    const res = await UpdateTicket(
      makeRequest("PUT", { name: "Allied Health" }),
      makeDetailParams("evt-1", "tt-1")
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Allied Health");
  });

  it("rejects duplicate name", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.ticketType.findFirst
      .mockResolvedValueOnce(sampleTicketType) // existing ticket
      .mockResolvedValueOnce({ id: "tt-other" }); // duplicate found

    const res = await UpdateTicket(
      makeRequest("PUT", { name: "Student" }),
      makeDetailParams("evt-1", "tt-1")
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 for non-existent type", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.ticketType.findFirst.mockResolvedValue(null); // ticket not found

    const res = await UpdateTicket(
      makeRequest("PUT", { name: "Updated" }),
      makeDetailParams("evt-1", "tt-missing")
    );
    expect(res.status).toBe(404);
  });

  it("logs update with apiLogger.info", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.ticketType.findFirst
      .mockResolvedValueOnce(sampleTicketType) // existing ticket
      .mockResolvedValueOnce(null); // no duplicate
    mockDb.ticketType.update.mockResolvedValue({ ...sampleTicketType, name: "Updated" });

    await UpdateTicket(
      makeRequest("PUT", { name: "Updated" }),
      makeDetailParams("evt-1", "tt-1")
    );

    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "Registration type updated",
        eventId: "evt-1",
        ticketTypeId: "tt-1",
      })
    );
  });
});

describe("DELETE /api/events/[eventId]/tickets/[ticketId]", () => {
  it("deletes type with no registrations", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue({ ...sampleTicketType, _count: { registrations: 0 } });
    mockDb.ticketType.delete.mockResolvedValue({});

    const res = await DeleteTicket(
      makeRequest("DELETE"),
      makeDetailParams("evt-1", "tt-1")
    );
    expect(res.status).toBe(200);
  });

  it("blocks deletion when registrations exist", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue(sampleTicketType); // has 5 registrations

    const res = await DeleteTicket(
      makeRequest("DELETE"),
      makeDetailParams("evt-1", "tt-1")
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("existing registrations");
  });

  it("logs deletion with apiLogger.info", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue({ ...sampleTicketType, _count: { registrations: 0 } });
    mockDb.ticketType.delete.mockResolvedValue({});

    await DeleteTicket(
      makeRequest("DELETE"),
      makeDetailParams("evt-1", "tt-1")
    );

    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "Registration type deleted",
        eventId: "evt-1",
        ticketTypeId: "tt-1",
      })
    );
  });

  it("rejects reviewer role", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const res = await DeleteTicket(
      makeRequest("DELETE"),
      makeDetailParams("evt-1", "tt-1")
    );
    expect(res.status).toBe(403);
  });
});

describe("Tier slug generation", () => {
  function toSlug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  it("converts 'Early Bird' to 'early-bird'", () => {
    expect(toSlug("Early Bird")).toBe("early-bird");
  });

  it("converts 'Standard' to 'standard'", () => {
    expect(toSlug("Standard")).toBe("standard");
  });

  it("converts 'Onsite' to 'onsite'", () => {
    expect(toSlug("Onsite")).toBe("onsite");
  });

  it("handles special characters", () => {
    expect(toSlug("Ph.D. Students & Post-Docs")).toBe("ph-d-students-post-docs");
  });

  it("handles empty string", () => {
    expect(toSlug("")).toBe("");
  });
});
