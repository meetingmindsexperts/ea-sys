/**
 * Unit tests for src/services/speaker-service.ts — Phase 2b extraction of
 * speaker-create logic. Shared by the REST admin POST route and the MCP
 * `create_speaker` tool.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockSyncToContact, mockRefreshStats, mockNotifyAdmins } = vi.hoisted(() => {
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      speaker: { findFirst: vi.fn(), create: vi.fn() },
      auditLog: { create: vi.fn() },
    },
    mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    mockSyncToContact: vi.fn(),
    mockRefreshStats: vi.fn(),
    mockNotifyAdmins: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: mockSyncToContact }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: mockRefreshStats }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: mockNotifyAdmins }));

import { createSpeaker } from "@/services/speaker-service";

const BASE_INPUT = {
  eventId: "evt-1",
  organizationId: "org-1",
  userId: "user-1",
  email: "Alice@Example.com",
  firstName: "Alice",
  lastName: "Smith",
  source: "rest" as const,
};

const CREATED_SPEAKER = {
  id: "spk-1",
  eventId: "evt-1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Smith",
  status: "INVITED",
  title: null,
  bio: null,
  organization: null,
  jobTitle: null,
  phone: null,
  website: null,
  photo: null,
  city: null,
  country: null,
  specialty: null,
  registrationType: null,
  tags: [],
  socialLinks: {},
  userId: null,
  agreementAcceptedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  _count: { sessions: 0, abstracts: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
  mockDb.speaker.findFirst.mockResolvedValue(null);
  mockDb.speaker.create.mockResolvedValue(CREATED_SPEAKER);
  mockDb.auditLog.create.mockResolvedValue({});
  mockSyncToContact.mockResolvedValue(undefined);
  mockNotifyAdmins.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("createSpeaker — happy path", () => {
  it("returns ok=true with the created speaker", async () => {
    const result = await createSpeaker(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.speaker.id).toBe("spk-1");
  });

  it("lowercases and trims the email before DB lookup and create", async () => {
    await createSpeaker({ ...BASE_INPUT, email: "  Alice@Example.com  " });
    const findCall = mockDb.speaker.findFirst.mock.calls[0][0];
    const createCall = mockDb.speaker.create.mock.calls[0][0];
    expect(findCall.where.email).toBe("alice@example.com");
    expect(createCall.data.email).toBe("alice@example.com");
  });

  it("defaults status to INVITED when omitted", async () => {
    await createSpeaker(BASE_INPUT);
    const createCall = mockDb.speaker.create.mock.calls[0][0];
    expect(createCall.data.status).toBe("INVITED");
  });

  it("persists a caller-supplied status (e.g. CONFIRMED)", async () => {
    await createSpeaker({ ...BASE_INPUT, status: "CONFIRMED" });
    const createCall = mockDb.speaker.create.mock.calls[0][0];
    expect(createCall.data.status).toBe("CONFIRMED");
  });

  it("defaults tags to [] and socialLinks to {} when omitted", async () => {
    await createSpeaker(BASE_INPUT);
    const createCall = mockDb.speaker.create.mock.calls[0][0];
    expect(createCall.data.tags).toEqual([]);
    expect(createCall.data.socialLinks).toEqual({});
  });

  it("calls syncToContact with the full payload (parity with REST)", async () => {
    await createSpeaker({
      ...BASE_INPUT,
      title: "DR",
      bio: "Bio text",
      organization: "MIT",
      jobTitle: "Prof",
      phone: "+1234",
      city: "Boston",
      country: "USA",
      photo: "/uploads/photos/alice.jpg",
      specialty: "Cardiology",
      registrationType: "Speaker",
    });
    const call = mockSyncToContact.mock.calls[0][0];
    expect(call).toMatchObject({
      organizationId: "org-1",
      eventId: "evt-1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
      title: "DR",
      organization: "MIT",
      jobTitle: "Prof",
      phone: "+1234",
      photo: "/uploads/photos/alice.jpg",
      city: "Boston",
      country: "USA",
      bio: "Bio text",
      specialty: "Cardiology",
      registrationType: "Speaker",
    });
  });

  it("writes audit log with source=rest + requestIp when provided", async () => {
    await createSpeaker({ ...BASE_INPUT, requestIp: "1.2.3.4" });
    const auditCall = mockDb.auditLog.create.mock.calls[0][0];
    expect(auditCall.data).toMatchObject({
      eventId: "evt-1",
      userId: "user-1",
      action: "CREATE",
      entityType: "Speaker",
      entityId: "spk-1",
      changes: expect.objectContaining({ source: "rest", email: "alice@example.com", ip: "1.2.3.4" }),
    });
  });

  it("writes audit log with source=mcp and omits ip when MCP caller", async () => {
    await createSpeaker({ ...BASE_INPUT, source: "mcp" });
    const auditCall = mockDb.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.changes.source).toBe("mcp");
    expect(auditCall.data.changes.ip).toBeUndefined();
  });

  it("refreshes event stats after create (fire-and-forget)", async () => {
    await createSpeaker(BASE_INPUT);
    expect(mockRefreshStats).toHaveBeenCalledWith("evt-1");
  });

  it("notifies admins with plain message on REST path", async () => {
    await createSpeaker(BASE_INPUT);
    const call = mockNotifyAdmins.mock.calls[0];
    expect(call[0]).toBe("evt-1");
    expect(call[1].message).toBe("Alice Smith added as speaker");
  });

  it("notifies admins with '(via MCP)' suffix on MCP path", async () => {
    await createSpeaker({ ...BASE_INPUT, source: "mcp" });
    const call = mockNotifyAdmins.mock.calls[0];
    expect(call[1].message).toBe("Alice Smith added as speaker (via MCP)");
  });

  it("normalizes empty-string optional fields to null (direct-caller safety)", async () => {
    // A direct-to-service caller (future external API, test) might pass ""
    // for unset optional fields. The service must coerce to null so the
    // Prisma title enum doesn't reject "" and Contact records don't get
    // spurious empty strings. REST + MCP callers normalize at their own
    // boundary, but the service is the last line of defense.
    await createSpeaker({
      ...BASE_INPUT,
      title: "" as never,
      bio: "",
      organization: "",
      jobTitle: "",
      phone: "",
      website: "",
      photo: "",
      city: "",
      country: "",
      specialty: "",
      registrationType: "",
    });
    const createCall = mockDb.speaker.create.mock.calls[0][0];
    expect(createCall.data.title).toBeNull();
    expect(createCall.data.bio).toBeNull();
    expect(createCall.data.organization).toBeNull();
    expect(createCall.data.jobTitle).toBeNull();
    expect(createCall.data.phone).toBeNull();
    expect(createCall.data.website).toBeNull();
    expect(createCall.data.photo).toBeNull();
    expect(createCall.data.city).toBeNull();
    expect(createCall.data.country).toBeNull();
    expect(createCall.data.specialty).toBeNull();
    expect(createCall.data.registrationType).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Domain errors
// ─────────────────────────────────────────────────────────────────────────────

describe("createSpeaker — domain errors", () => {
  it("EVENT_NOT_FOUND when event lookup returns null (cross-org access)", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const result = await createSpeaker(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EVENT_NOT_FOUND");
    expect(mockDb.speaker.create).not.toHaveBeenCalled();
  });

  it("SPEAKER_ALREADY_EXISTS when a speaker with the same email is pre-existing", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk-existing" });
    const result = await createSpeaker(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SPEAKER_ALREADY_EXISTS");
      // meta.existingSpeakerId is wire-load-bearing — the MCP tool reads it
      // to surface `existingId` in the auto-pivot hint. If this key gets
      // renamed, Claude's auto-pivot to update_speaker silently breaks.
      expect(result.meta).toEqual({ existingSpeakerId: "spk-existing" });
    }
    expect(mockDb.speaker.create).not.toHaveBeenCalled();
  });

  it("SPEAKER_ALREADY_EXISTS on P2002 race (pre-check passed, concurrent insert collided)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(null);
    mockDb.speaker.create.mockRejectedValue(
      new Error("Unique constraint failed on the fields: (`email`,`eventId`)")
    );
    const result = await createSpeaker(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SPEAKER_ALREADY_EXISTS");
  });

  it("UNKNOWN for unexpected DB failures", async () => {
    mockDb.speaker.create.mockRejectedValue(new Error("Connection refused"));
    const result = await createSpeaker(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN");
      expect(result.message).toContain("Connection refused");
    }
    // Side effects must not fire on failure
    expect(mockSyncToContact).not.toHaveBeenCalled();
    expect(mockNotifyAdmins).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockRefreshStats).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-blocking side effects
// ─────────────────────────────────────────────────────────────────────────────

describe("createSpeaker — side-effect isolation", () => {
  it("audit-log failure is non-blocking (happy path still returns ok=true)", async () => {
    mockDb.auditLog.create.mockRejectedValue(new Error("audit DB down"));
    const result = await createSpeaker(BASE_INPUT);
    expect(result.ok).toBe(true);
  });

  it("notifyEventAdmins failure is non-blocking", async () => {
    mockNotifyAdmins.mockRejectedValue(new Error("notify down"));
    const result = await createSpeaker(BASE_INPUT);
    expect(result.ok).toBe(true);
  });
});
