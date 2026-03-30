import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAuth, mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    notification: {
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
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

import { GET, PUT } from "@/app/api/notifications/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(method: string, body?: unknown, searchParams?: string) {
  const url = `http://localhost/api/notifications${searchParams ? `?${searchParams}` : ""}`;
  return new Request(url, {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

const adminSession = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };

const sampleNotifications = [
  {
    id: "notif-1",
    type: "REGISTRATION",
    title: "New Registration",
    message: "John registered",
    link: "/events/evt-1/registrations",
    isRead: false,
    createdAt: new Date("2026-03-30T10:00:00Z"),
    eventId: "evt-1",
  },
  {
    id: "notif-2",
    type: "PAYMENT",
    title: "Payment Received",
    message: "Payment of $100",
    link: null,
    isRead: true,
    createdAt: new Date("2026-03-30T09:00:00Z"),
    eventId: "evt-1",
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/notifications", () => {
  it("returns notifications for authenticated user only", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.notification.findMany.mockResolvedValue(sampleNotifications);
    mockDb.notification.count.mockResolvedValue(1);

    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.notifications).toHaveLength(2);
    expect(data.notifications[0].id).toBe("notif-1");
    expect(data.notifications[0].title).toBe("New Registration");
  });

  it("returns unreadCount", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.notification.findMany.mockResolvedValue(sampleNotifications);
    mockDb.notification.count.mockResolvedValue(3);

    const res = await GET(makeRequest("GET"));
    const data = await res.json();
    expect(data.unreadCount).toBe(3);
  });

  it("returns 401 for unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(401);
  });

  it("returns 401 for session with no user id", async () => {
    mockAuth.mockResolvedValue({ user: {} });

    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(401);
  });

  it("filters unread only when unreadOnly=true", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.notification.findMany.mockResolvedValue([sampleNotifications[0]]);
    mockDb.notification.count.mockResolvedValue(1);

    const res = await GET(makeRequest("GET", undefined, "unreadOnly=true"));
    expect(res.status).toBe(200);

    // Verify findMany was called with isRead filter
    expect(mockDb.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          isRead: false,
        }),
      })
    );
  });
});

describe("PUT /api/notifications", () => {
  it("marks specific notification IDs as read", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.notification.updateMany.mockResolvedValue({ count: 2 });

    const res = await PUT(makeRequest("PUT", { ids: ["notif-1", "notif-2"] }));
    expect(res.status).toBe(200);

    expect(mockDb.notification.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["notif-1", "notif-2"] },
        userId: "user-1",
      },
      data: { isRead: true },
    });
  });

  it("marks all notifications as read when { all: true }", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.notification.updateMany.mockResolvedValue({ count: 5 });

    const res = await PUT(makeRequest("PUT", { all: true }));
    expect(res.status).toBe(200);

    expect(mockDb.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", isRead: false },
      data: { isRead: true },
    });
  });

  it("returns 401 for unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await PUT(makeRequest("PUT", { all: true }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when neither ids nor all is provided", async () => {
    mockAuth.mockResolvedValue(adminSession);

    const res = await PUT(makeRequest("PUT", {}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when ids is empty array", async () => {
    mockAuth.mockResolvedValue(adminSession);

    const res = await PUT(makeRequest("PUT", { ids: [] }));
    expect(res.status).toBe(400);
  });
});
