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

const sampleTicket = {
  id: "tt-1",
  eventId: "evt-1",
  name: "Physician - Early Bird",
  description: null,
  category: "Early Bird",
  price: 100,
  currency: "USD",
  quantity: 50,
  soldCount: 5,
  maxPerOrder: 10,
  salesStart: null,
  salesEnd: null,
  isActive: true,
  requiresApproval: false,
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

  it("returns ticket types for valid event", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findMany.mockResolvedValue([sampleTicket]);
    const res = await ListTickets(makeRequest("GET"), makeListParams("evt-1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].category).toBe("Early Bird");
  });
});

describe("POST /api/events/[eventId]/tickets — custom categories", () => {
  it("creates a ticket with default category 'Standard'", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const created = { ...sampleTicket, id: "tt-new", category: "Standard", name: "General Admission" };
    mockDb.ticketType.create.mockResolvedValue(created);

    const res = await CreateTicket(
      makeRequest("POST", { name: "General Admission", price: 0, quantity: 100 }),
      makeListParams("evt-1")
    );
    expect(res.status).toBe(201);

    // Verify the DB was called with default category
    expect(mockDb.ticketType.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: "Standard" }),
      })
    );
  });

  it("creates a ticket with a custom category like 'VIP'", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const created = { ...sampleTicket, id: "tt-vip", category: "VIP", name: "VIP Access" };
    mockDb.ticketType.create.mockResolvedValue(created);

    const res = await CreateTicket(
      makeRequest("POST", { name: "VIP Access", category: "VIP", price: 500, quantity: 20 }),
      makeListParams("evt-1")
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.category).toBe("VIP");
  });

  it("creates a ticket with 'Early Bird' category", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const created = { ...sampleTicket, category: "Early Bird" };
    mockDb.ticketType.create.mockResolvedValue(created);

    const res = await CreateTicket(
      makeRequest("POST", { name: "Physician - Early Bird", category: "Early Bird", price: 100, quantity: 50 }),
      makeListParams("evt-1")
    );
    expect(res.status).toBe(201);
    expect(mockDb.ticketType.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: "Early Bird" }),
      })
    );
  });

  it("creates a ticket with a long custom category (up to 100 chars)", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const longCategory = "A".repeat(100);
    const created = { ...sampleTicket, category: longCategory };
    mockDb.ticketType.create.mockResolvedValue(created);

    const res = await CreateTicket(
      makeRequest("POST", { name: "Test", category: longCategory, price: 0, quantity: 10 }),
      makeListParams("evt-1")
    );
    expect(res.status).toBe(201);
  });

  it("rejects category longer than 100 chars", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const tooLong = "A".repeat(101);

    const res = await CreateTicket(
      makeRequest("POST", { name: "Test", category: tooLong, price: 0, quantity: 10 }),
      makeListParams("evt-1")
    );
    expect(res.status).toBe(400);
  });

  it("rejects reviewer role", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const res = await CreateTicket(
      makeRequest("POST", { name: "Test", price: 0, quantity: 10 }),
      makeListParams("evt-1")
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on invalid input (missing name)", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const res = await CreateTicket(
      makeRequest("POST", { price: 0, quantity: 10 }),
      makeListParams("evt-1")
    );
    expect(res.status).toBe(400);
  });

  it("logs successful creation with apiLogger.info", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.create.mockResolvedValue({ ...sampleTicket, id: "tt-log" });

    await CreateTicket(
      makeRequest("POST", { name: "Logged Ticket", category: "Student", price: 25, quantity: 100 }),
      makeListParams("evt-1")
    );

    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "Ticket type created",
        eventId: "evt-1",
        ticketTypeId: "tt-log",
        category: "Student",
        name: "Logged Ticket",
      })
    );
  });
});

describe("PUT /api/events/[eventId]/tickets/[ticketId] — category update", () => {
  beforeEach(() => {
    mockDb.ticketType.findFirst.mockResolvedValue(sampleTicket);
  });

  it("updates category to a custom value", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const updated = { ...sampleTicket, category: "Industry Partner" };
    mockDb.ticketType.update.mockResolvedValue(updated);

    const res = await UpdateTicket(
      makeRequest("PUT", { category: "Industry Partner" }),
      makeDetailParams("evt-1", "tt-1")
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.category).toBe("Industry Partner");
  });

  it("updates category from custom to another custom", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const updated = { ...sampleTicket, category: "Government" };
    mockDb.ticketType.update.mockResolvedValue(updated);

    const res = await UpdateTicket(
      makeRequest("PUT", { category: "Government" }),
      makeDetailParams("evt-1", "tt-1")
    );
    expect(res.status).toBe(200);
    expect(mockDb.ticketType.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: "Government" }),
      })
    );
  });

  it("rejects quantity less than soldCount", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const res = await UpdateTicket(
      makeRequest("PUT", { quantity: 3 }),
      makeDetailParams("evt-1", "tt-1")
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("sold count");
  });

  it("returns 404 for non-existent ticket", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue(null);
    const res = await UpdateTicket(
      makeRequest("PUT", { name: "Updated" }),
      makeDetailParams("evt-1", "tt-missing")
    );
    expect(res.status).toBe(404);
  });

  it("logs successful update with apiLogger.info", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.update.mockResolvedValue({ ...sampleTicket, category: "Sponsor" });

    await UpdateTicket(
      makeRequest("PUT", { category: "Sponsor" }),
      makeDetailParams("evt-1", "tt-1")
    );

    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "Ticket type updated",
        eventId: "evt-1",
        ticketTypeId: "tt-1",
      })
    );
  });
});

describe("DELETE /api/events/[eventId]/tickets/[ticketId]", () => {
  it("deletes a ticket with no registrations", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue({ ...sampleTicket, _count: { registrations: 0 } });
    mockDb.ticketType.delete.mockResolvedValue({});

    const res = await DeleteTicket(
      makeRequest("DELETE"),
      makeDetailParams("evt-1", "tt-1")
    );
    expect(res.status).toBe(200);
  });

  it("blocks deletion when registrations exist", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue(sampleTicket); // has 5 registrations

    const res = await DeleteTicket(
      makeRequest("DELETE"),
      makeDetailParams("evt-1", "tt-1")
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("existing registrations");
  });

  it("logs successful deletion with apiLogger.info", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.ticketType.findFirst.mockResolvedValue({ ...sampleTicket, _count: { registrations: 0 } });
    mockDb.ticketType.delete.mockResolvedValue({});

    await DeleteTicket(
      makeRequest("DELETE"),
      makeDetailParams("evt-1", "tt-1")
    );

    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "Ticket type deleted",
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

describe("Category slug generation (integration-level)", () => {
  // These test the toSlug logic used in the public pages
  function toSlug(category: string): string {
    return category
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  it("converts 'Early Bird' to 'early-bird'", () => {
    expect(toSlug("Early Bird")).toBe("early-bird");
  });

  it("converts 'Standard' to 'standard'", () => {
    expect(toSlug("Standard")).toBe("standard");
  });

  it("converts 'VIP Access' to 'vip-access'", () => {
    expect(toSlug("VIP Access")).toBe("vip-access");
  });

  it("converts 'Industry / Partner' to 'industry-partner'", () => {
    expect(toSlug("Industry / Partner")).toBe("industry-partner");
  });

  it("handles special characters", () => {
    expect(toSlug("Ph.D. Students & Post-Docs")).toBe("ph-d-students-post-docs");
  });

  it("handles leading/trailing special chars", () => {
    expect(toSlug("--Custom--")).toBe("custom");
  });

  it("handles unicode/non-ASCII gracefully", () => {
    expect(toSlug("Présentateur")).toBe("pr-sentateur");
  });

  it("handles empty string", () => {
    expect(toSlug("")).toBe("");
  });
});
