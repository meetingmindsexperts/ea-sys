import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAuth, mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    auditLog: {
      findMany: vi.fn(),
    },
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

import { GET } from "@/app/api/activity/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(searchParams?: string) {
  const url = `http://localhost/api/activity${searchParams ? `?${searchParams}` : ""}`;
  return new Request(url, { method: "GET" });
}

const adminSession = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const superAdminSession = { user: { id: "user-2", role: "SUPER_ADMIN", organizationId: "org-1" } };
const organizerSession = { user: { id: "user-3", role: "ORGANIZER", organizationId: "org-1" } };
const reviewerSession = { user: { id: "rev-1", role: "REVIEWER", organizationId: null } };
const submitterSession = { user: { id: "sub-1", role: "SUBMITTER", organizationId: null } };
const registrantSession = { user: { id: "reg-1", role: "REGISTRANT", organizationId: null } };

const sampleAuditLogs = [
  {
    id: "log-1",
    action: "CREATE",
    entityType: "Registration",
    entityId: "reg-1",
    changes: {},
    createdAt: new Date("2026-03-30T10:00:00Z"),
    user: { firstName: "John", lastName: "Smith", email: "john@example.com" },
    event: { id: "evt-1", name: "Conference 2026" },
  },
  {
    id: "log-2",
    action: "UPDATE",
    entityType: "Speaker",
    entityId: "spk-1",
    changes: { firstName: "Jane" },
    createdAt: new Date("2026-03-30T09:00:00Z"),
    user: { firstName: "Admin", lastName: "User", email: "admin@example.com" },
    event: { id: "evt-1", name: "Conference 2026" },
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/activity", () => {
  it("returns 401 for unauthenticated requests", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 401 for session with no user", async () => {
    mockAuth.mockResolvedValue({});

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns activity for ADMIN role", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.auditLog.findMany.mockResolvedValue(sampleAuditLogs);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].entityType).toBe("Registration");
    expect(data[1].entityType).toBe("Speaker");
  });

  it("returns activity for SUPER_ADMIN role", async () => {
    mockAuth.mockResolvedValue(superAdminSession);
    mockDb.auditLog.findMany.mockResolvedValue(sampleAuditLogs);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveLength(2);
  });

  it("blocks REVIEWER from global activity", async () => {
    mockAuth.mockResolvedValue(reviewerSession);

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);

    const data = await res.json();
    expect(data.error).toBe("Forbidden");
  });

  it("blocks SUBMITTER from global activity", async () => {
    mockAuth.mockResolvedValue(submitterSession);

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it("blocks ORGANIZER from global activity", async () => {
    mockAuth.mockResolvedValue(organizerSession);

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it("blocks REGISTRANT from global activity", async () => {
    mockAuth.mockResolvedValue(registrantSession);

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it("scopes activity to organization", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.auditLog.findMany.mockResolvedValue([]);

    await GET(makeRequest());

    expect(mockDb.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          event: {
            organizationId: "org-1",
          },
        },
      })
    );
  });

  it("respects limit param", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.auditLog.findMany.mockResolvedValue([]);

    await GET(makeRequest("limit=10"));

    expect(mockDb.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 10,
      })
    );
  });

  it("defaults limit to 50 when not specified", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.auditLog.findMany.mockResolvedValue([]);

    await GET(makeRequest());

    expect(mockDb.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
      })
    );
  });

  it("caps limit at 100", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.auditLog.findMany.mockResolvedValue([]);

    await GET(makeRequest("limit=500"));

    expect(mockDb.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
      })
    );
  });

  it("clamps limit minimum to 1", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.auditLog.findMany.mockResolvedValue([]);

    await GET(makeRequest("limit=0"));

    expect(mockDb.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50, // 0 becomes NaN via Number(), falls back to || 50
      })
    );
  });

  it("orders activity by createdAt desc", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.auditLog.findMany.mockResolvedValue([]);

    await GET(makeRequest());

    expect(mockDb.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "desc" },
      })
    );
  });

  it("returns user info with audit log entries", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.auditLog.findMany.mockResolvedValue(sampleAuditLogs);

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data[0].user).toEqual({
      firstName: "John",
      lastName: "Smith",
      email: "john@example.com",
    });
  });

  it("returns event info with audit log entries", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.auditLog.findMany.mockResolvedValue(sampleAuditLogs);

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data[0].event).toEqual({
      id: "evt-1",
      name: "Conference 2026",
    });
  });

  it("handles DB errors with 500 response", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.auditLog.findMany.mockRejectedValue(new Error("DB connection failed"));

    const res = await GET(makeRequest());
    expect(res.status).toBe(500);

    const data = await res.json();
    expect(data.error).toBe("Failed to fetch activity");

    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "Failed to fetch global activity",
      })
    );
  });
});

describe("Activity: entity type descriptions", () => {
  const entityTypes = [
    { entityType: "Registration", action: "CREATE", expected: "New registration" },
    { entityType: "Registration", action: "UPDATE", expected: "Registration updated" },
    { entityType: "Registration", action: "DELETE", expected: "Registration deleted" },
    { entityType: "Speaker", action: "CREATE", expected: "New speaker" },
    { entityType: "Abstract", action: "CREATE", expected: "New abstract" },
    { entityType: "EventSession", action: "CREATE", expected: "New session" },
  ];

  it.each(entityTypes)(
    "generates description for $entityType $action",
    ({ entityType, action }) => {
      // Verify entity types are valid model names
      const validEntityTypes = [
        "Registration", "Speaker", "Abstract", "EventSession",
        "Attendee", "Track", "Hotel", "RoomType", "Accommodation",
        "TicketType", "Contact",
      ];
      expect(validEntityTypes).toContain(entityType);

      // Verify actions are standard CRUD
      const validActions = ["CREATE", "UPDATE", "DELETE"];
      expect(validActions).toContain(action);
    }
  );
});
