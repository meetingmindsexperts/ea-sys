import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockDb: {
    notification: {
      create: vi.fn(),
      createMany: vi.fn(),
    },
    event: {
      findUnique: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import { createNotification, notifyEventAdmins } from "@/lib/notifications";

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createNotification", () => {
  it("creates a notification record", async () => {
    mockDb.notification.create.mockResolvedValue({ id: "notif-1" });

    await createNotification({
      userId: "user-1",
      eventId: "evt-1",
      type: "REGISTRATION",
      title: "New Registration",
      message: "John Smith registered for the event",
      link: "/events/evt-1/registrations",
    });

    expect(mockDb.notification.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        eventId: "evt-1",
        type: "REGISTRATION",
        title: "New Registration",
        message: "John Smith registered for the event",
        link: "/events/evt-1/registrations",
      },
    });
  });

  it("handles errors gracefully (does not throw)", async () => {
    mockDb.notification.create.mockRejectedValue(new Error("DB error"));

    // Should not throw
    await expect(
      createNotification({
        userId: "user-1",
        type: "PAYMENT",
        title: "Payment",
        message: "Payment received",
      })
    ).resolves.toBeUndefined();

    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "Failed to create notification",
        userId: "user-1",
        type: "PAYMENT",
      })
    );
  });

  it("creates notification without optional fields", async () => {
    mockDb.notification.create.mockResolvedValue({ id: "notif-2" });

    await createNotification({
      userId: "user-1",
      type: "CHECK_IN",
      title: "Check-in",
      message: "Attendee checked in",
    });

    expect(mockDb.notification.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        type: "CHECK_IN",
        title: "Check-in",
        message: "Attendee checked in",
      },
    });
  });
});

describe("notifyEventAdmins", () => {
  it("finds all admins/organizers for the event's org and creates notifications", async () => {
    mockDb.event.findUnique.mockResolvedValue({ organizationId: "org-1" });
    mockDb.user.findMany.mockResolvedValue([
      { id: "admin-1" },
      { id: "admin-2" },
      { id: "organizer-1" },
    ]);
    mockDb.notification.createMany.mockResolvedValue({ count: 3 });

    await notifyEventAdmins("evt-1", {
      type: "REGISTRATION",
      title: "New Registration",
      message: "Someone registered",
    });

    expect(mockDb.event.findUnique).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      select: { organizationId: true },
    });

    expect(mockDb.user.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        role: { in: ["SUPER_ADMIN", "ADMIN", "ORGANIZER"] },
      },
      select: { id: true },
    });

    expect(mockDb.notification.createMany).toHaveBeenCalledWith({
      data: [
        { userId: "admin-1", eventId: "evt-1", type: "REGISTRATION", title: "New Registration", message: "Someone registered" },
        { userId: "admin-2", eventId: "evt-1", type: "REGISTRATION", title: "New Registration", message: "Someone registered" },
        { userId: "organizer-1", eventId: "evt-1", type: "REGISTRATION", title: "New Registration", message: "Someone registered" },
      ],
    });
  });

  it("handles missing event gracefully", async () => {
    mockDb.event.findUnique.mockResolvedValue(null);

    await notifyEventAdmins("nonexistent-evt", {
      type: "REGISTRATION",
      title: "Test",
      message: "Test",
    });

    expect(mockDb.user.findMany).not.toHaveBeenCalled();
    expect(mockDb.notification.createMany).not.toHaveBeenCalled();
  });

  it("handles empty admin list", async () => {
    mockDb.event.findUnique.mockResolvedValue({ organizationId: "org-1" });
    mockDb.user.findMany.mockResolvedValue([]);

    await notifyEventAdmins("evt-1", {
      type: "ABSTRACT",
      title: "Abstract Submitted",
      message: "New abstract",
    });

    expect(mockDb.notification.createMany).not.toHaveBeenCalled();
  });

  it("handles DB errors gracefully (does not throw)", async () => {
    mockDb.event.findUnique.mockRejectedValue(new Error("DB error"));

    await expect(
      notifyEventAdmins("evt-1", {
        type: "REVIEW",
        title: "Review",
        message: "Review completed",
      })
    ).resolves.toBeUndefined();

    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "Failed to notify event admins",
        eventId: "evt-1",
      })
    );
  });
});

describe("Notification types", () => {
  const validTypes = ["REGISTRATION", "PAYMENT", "ABSTRACT", "REVIEW", "CHECK_IN"] as const;

  it.each(validTypes)("type %s is a valid notification type", async (type) => {
    mockDb.notification.create.mockResolvedValue({ id: "notif-test" });

    await createNotification({
      userId: "user-1",
      type,
      title: "Test",
      message: "Test message",
    });

    expect(mockDb.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type }),
    });
  });
});
