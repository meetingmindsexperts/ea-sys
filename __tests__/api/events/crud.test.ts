import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAuth, mockDb, mockUpdateEventSettings, mockCascadeUpdateSession } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCascadeUpdateSession: vi.fn(),
  mockDb: {
    event: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
    // Financial-records guard on event DELETE — default to "none" so existing
    // delete tests proceed; the guard's own behavior is covered in
    // event-delete-financial-guard.test.ts.
    invoice: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    payment: { count: vi.fn().mockResolvedValue(0) },
    // M9 date-narrowing guard on PUT — default to "no sessions" so tests
    // that change dates proceed unless they set this up explicitly.
    eventSession: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
  },
  // Settings now merge through the atomic helper (its own test covers the merge);
  // here we just assert the route hands it the right patch.
  mockUpdateEventSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(),
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

vi.mock("@/lib/db", () => ({ db: mockDb }));

vi.mock("@/lib/event-settings", () => ({
  updateEventSettings: (...args: unknown[]) => mockUpdateEventSettings(...args),
  updateOrganizationSettings: vi.fn(),
}));

vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: vi.fn(
    (user: { role: string; organizationId?: string | null }, eventId?: string) => ({
      ...(eventId && { id: eventId }),
      organizationId: user.organizationId,
    })
  ),
}));

vi.mock("@/lib/security", () => ({
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

// The WEBINAR anchor cascade delegates to the session service (which carries
// the Zoom sync + email-sequence reschedule) — mocked here; its own behavior
// is covered in __tests__/services/session-service.test.ts.
vi.mock("@/services/session-service", () => ({
  updateSession: (...a: unknown[]) => mockCascadeUpdateSession(...a),
}));

// Import route AFTER mocks
import { GET, PUT, DELETE } from "@/app/api/events/[eventId]/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeParams(eventId: string) {
  return { params: Promise.resolve({ eventId }) };
}

function makeGetRequest() {
  return new Request("http://localhost/api/events/evt-1", { method: "GET" });
}

function makePutRequest(body: unknown) {
  return new Request("http://localhost/api/events/evt-1", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest() {
  return new Request("http://localhost/api/events/evt-1?confirm=true", { method: "DELETE" });
}

const adminSession = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const reviewerSession = { user: { id: "rev-1", role: "REVIEWER", organizationId: null } };
const submitterSession = { user: { id: "sub-1", role: "SUBMITTER", organizationId: null } };

const sampleEvent = {
  id: "evt-1",
  organizationId: "org-1",
  name: "Test Event",
  slug: "test-event",
  description: "A test event",
  status: "DRAFT",
  startDate: new Date("2026-06-01"),
  endDate: new Date("2026-06-03"),
  settings: {},
  _count: { registrations: 10, speakers: 5, eventSessions: 3, tracks: 2 },
};

// ── GET Tests ────────────────────────────────────────────────────────────────

describe("GET /api/events/[eventId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(makeGetRequest(), makeParams("evt-1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when event not found", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await GET(makeGetRequest(), makeParams("evt-1"));
    expect(res.status).toBe(404);
  });

  it("returns event data for authenticated user", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(sampleEvent);
    const res = await GET(makeGetRequest(), makeParams("evt-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Test Event");
    expect(body._count.registrations).toBe(10);
  });

  it("returns 500 on database error", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockRejectedValue(new Error("DB error"));
    const res = await GET(makeGetRequest(), makeParams("evt-1"));
    expect(res.status).toBe(500);
  });

  // ── Org-null read access (Aug 6, 2026 warning-triage fix) ─────────────────
  // The July 24 requireOrgId sweep 403'd every SUBMITTER/REVIEWER page for 13
  // days (event name/dates/guidelines/deadlines never loaded). The GET now
  // authorizes ONLY via buildEventAccessWhere — these pins stop the next
  // guard sweep from re-breaking org-null readers.

  it("a linked SUBMITTER (org-null) reads the event — never 403", async () => {
    mockAuth.mockResolvedValue(submitterSession);
    mockDb.event.findFirst.mockResolvedValue(sampleEvent);
    const res = await GET(makeGetRequest(), makeParams("evt-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Test Event");
  });

  it("a REVIEWER (org-null) reads the event — never 403", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    mockDb.event.findFirst.mockResolvedValue(sampleEvent);
    const res = await GET(makeGetRequest(), makeParams("evt-1"));
    expect(res.status).toBe(200);
  });

  it("an UNLINKED org-null user 404s (buildEventAccessWhere finds nothing)", async () => {
    mockAuth.mockResolvedValue(submitterSession);
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await GET(makeGetRequest(), makeParams("evt-1"));
    expect(res.status).toBe(404);
  });

  it("SUBMITTER never fetches finance (or any other organiser) columns", async () => {
    // This used to assert the redactor stripped taxRate/bankDetails from a full
    // row. The row is no longer fetched: an org-null role gets a narrow select,
    // which also withholds everything the redactor never covered (settings JSON,
    // internal CC list, badge + seat config). Asserting on the SELECT is the
    // honest test — a mock returns whatever it is told regardless of `select`,
    // so asserting on the response body would pass against a widened query.
    mockAuth.mockResolvedValue(submitterSession);
    mockDb.event.findFirst.mockResolvedValue(sampleEvent);

    const res = await GET(makeGetRequest(), makeParams("evt-1"));
    expect(res.status).toBe(200);

    const select = mockDb.event.findFirst.mock.calls[0][0].select;
    expect(select).toBeDefined();
    for (const column of ["taxRate", "taxLabel", "bankDetails", "emailCcAddresses"]) {
      expect(select).not.toHaveProperty(column);
    }
    expect(select).toHaveProperty("name");
  });
});

// ── PUT Tests ────────────────────────────────────────────────────────────────

describe("PUT /api/events/[eventId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(makePutRequest({ name: "Updated" }), makeParams("evt-1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for REVIEWER role", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const res = await PUT(makePutRequest({ name: "Updated" }), makeParams("evt-1"));
    expect(res.status).toBe(403);
  });

  it("returns 403 for SUBMITTER role", async () => {
    mockAuth.mockResolvedValue(submitterSession);
    const res = await PUT(makePutRequest({ name: "Updated" }), makeParams("evt-1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when event not found", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await PUT(makePutRequest({ name: "Updated" }), makeParams("evt-1"));
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid input", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", slug: "test", settings: {} });
    const res = await PUT(makePutRequest({ name: "x" }), makeParams("evt-1")); // too short
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error", "Invalid input");
  });

  it("updates event successfully", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", slug: "test", settings: {} });
    mockDb.event.update.mockResolvedValue({ ...sampleEvent, name: "Updated Event" });
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    const res = await PUT(makePutRequest({ name: "Updated Event" }), makeParams("evt-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Updated Event");
  });

  // M9 (program/agenda review): narrowing the event's dates used to silently
  // orphan out-of-range sessions — they kept rendering on the public agenda
  // while any edit to them was rejected. The PUT now blocks with a clear
  // error naming the sessions.
  it("blocks a date change that would orphan out-of-range sessions", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({
      id: "evt-1",
      slug: "test",
      settings: {},
      startDate: new Date("2026-06-01T00:00:00Z"),
      endDate: new Date("2026-06-03T00:00:00Z"),
      timezone: "Asia/Dubai",
    });
    // A day-3 session (June 3, Dubai) that the shortened window drops.
    mockDb.eventSession.findMany.mockResolvedValue([
      {
        id: "sess-3",
        name: "Day 3 Closing",
        startTime: new Date("2026-06-03T05:00:00Z"),
        endTime: new Date("2026-06-03T06:00:00Z"),
      },
    ]);

    const res = await PUT(
      makePutRequest({
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-06-02T00:00:00.000Z", // 3 days → 2
      }),
      makeParams("evt-1"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("SESSIONS_OUTSIDE_NEW_DATES");
    expect(body.error).toContain("Day 3 Closing");
    expect(body.sessions).toHaveLength(1);
    expect(mockDb.event.update).not.toHaveBeenCalled();
  });

  it("allows a date change when every session still fits the new window", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({
      id: "evt-1",
      slug: "test",
      settings: {},
      startDate: new Date("2026-06-01T00:00:00Z"),
      endDate: new Date("2026-06-03T00:00:00Z"),
      timezone: "Asia/Dubai",
    });
    mockDb.eventSession.findMany.mockResolvedValue([
      {
        id: "sess-1",
        name: "Day 1 Opening",
        startTime: new Date("2026-06-01T05:00:00Z"),
        endTime: new Date("2026-06-01T06:00:00Z"),
      },
    ]);
    mockDb.event.update.mockResolvedValue(sampleEvent);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    const res = await PUT(
      makePutRequest({
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-06-02T00:00:00.000Z",
      }),
      makeParams("evt-1"),
    );
    expect(res.status).toBe(200);
    expect(mockDb.event.update).toHaveBeenCalled();
  });

  it("does not run the session check when dates are untouched", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", slug: "test", settings: {} });
    mockDb.event.update.mockResolvedValue(sampleEvent);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    const res = await PUT(makePutRequest({ name: "Renamed Event" }), makeParams("evt-1"));
    expect(res.status).toBe(200);
    expect(mockDb.eventSession.findMany).not.toHaveBeenCalled();
  });

  // Review H1: the Settings → General form always sends startDate/endDate/
  // timezone, so the guard must key on a COMPUTED change, not field presence —
  // otherwise a legacy out-of-range session locks every General save.
  it("skips the session check when dates are sent but unchanged (General-tab save)", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({
      id: "evt-1",
      slug: "test",
      settings: {},
      startDate: new Date("2026-06-01T00:00:00Z"),
      endDate: new Date("2026-06-03T00:00:00Z"),
      timezone: "Asia/Dubai",
    });
    mockDb.event.update.mockResolvedValue(sampleEvent);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    const res = await PUT(
      makePutRequest({
        name: "Renamed Event",
        // Same values the form echoes back on every save.
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-06-03T00:00:00.000Z",
        timezone: "Asia/Dubai",
      }),
      makeParams("evt-1"),
    );
    expect(res.status).toBe(200);
    expect(mockDb.eventSession.findMany).not.toHaveBeenCalled();
    expect(mockDb.event.update).toHaveBeenCalled();
  });

  it("excludes CANCELLED sessions from the date-narrowing guard", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({
      id: "evt-1",
      slug: "test",
      settings: {},
      startDate: new Date("2026-06-01T00:00:00Z"),
      endDate: new Date("2026-06-03T00:00:00Z"),
      timezone: "Asia/Dubai",
    });
    // The query itself filters cancelled rows out — assert the where clause.
    mockDb.eventSession.findMany.mockResolvedValue([]);
    mockDb.event.update.mockResolvedValue(sampleEvent);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    const res = await PUT(
      makePutRequest({
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-06-02T00:00:00.000Z", // real narrowing
      }),
      makeParams("evt-1"),
    );
    expect(res.status).toBe(200);
    const where = mockDb.eventSession.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ eventId: "evt-1", status: { not: "CANCELLED" } });
  });

  it("rejects duplicate slug", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst
      .mockResolvedValueOnce({ id: "evt-1", slug: "old-slug", settings: {} }) // existing event
      .mockResolvedValueOnce({ id: "evt-2" }); // slug already taken

    const res = await PUT(makePutRequest({ slug: "taken-slug" }), makeParams("evt-1"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("slug already exists");
  });

  it("merges settings with existing settings", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({
      id: "evt-1",
      slug: "test",
      settings: { registrationOpen: true, maxAttendees: 100 },
    });
    mockDb.event.update.mockResolvedValue(sampleEvent);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    await PUT(
      makePutRequest({ settings: { registrationOpen: false, waitlistEnabled: true } }),
      makeParams("evt-1")
    );

    // Settings now merge atomically via updateEventSettings (row-locked) instead
    // of an inline spread on db.event.update. The route hands it the incoming
    // patch; the helper merges it over the locked-current settings (covered in
    // event-settings.test.ts). The general PUT must NOT carry the settings on
    // the scalar db.event.update anymore.
    expect(mockUpdateEventSettings).toHaveBeenCalledWith("evt-1", {
      registrationOpen: false,
      waitlistEnabled: true,
    });
    const scalarUpdate = mockDb.event.update.mock.calls[0]?.[0];
    if (scalarUpdate) {
      expect(scalarUpdate.data).not.toHaveProperty("settings");
    }
  });

  it("refuses setting a NEW session-proposal deadline in the past (400 DEADLINE_IN_PAST)", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", slug: "test", settings: {} });
    const res = await PUT(
      makePutRequest({ settings: { sessionProposalDeadline: "2020-01-01T10:00:00.000Z" } }),
      makeParams("evt-1")
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("DEADLINE_IN_PAST");
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
  });

  it("an UNCHANGED already-past deadline still saves (unrelated settings edits never blocked)", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({
      id: "evt-1",
      slug: "test",
      settings: { sessionProposalDeadline: "2020-01-01T10:00:00.000Z" },
    });
    mockDb.event.update.mockResolvedValue(sampleEvent);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });
    const res = await PUT(
      makePutRequest({
        settings: { sessionProposalDeadline: "2020-01-01T10:00:00.000Z", registrationOpen: false },
      }),
      makeParams("evt-1")
    );
    expect(res.status).toBe(200);
    expect(mockUpdateEventSettings).toHaveBeenCalled();
  });

  it("a FUTURE deadline (extension) saves; clearing (null) always allowed", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({
      id: "evt-1",
      slug: "test",
      settings: { sessionProposalDeadline: "2020-01-01T10:00:00.000Z" },
    });
    mockDb.event.update.mockResolvedValue(sampleEvent);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });
    const future = new Date(Date.now() + 86400_000).toISOString();
    const res = await PUT(makePutRequest({ settings: { sessionProposalDeadline: future } }), makeParams("evt-1"));
    expect(res.status).toBe(200);

    const res2 = await PUT(makePutRequest({ settings: { sessionProposalDeadline: null } }), makeParams("evt-1"));
    expect(res2.status).toBe(200);
  });

  it("creates audit log on successful update", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", slug: "test", settings: {} });
    mockDb.event.update.mockResolvedValue(sampleEvent);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    await PUT(makePutRequest({ name: "New Name" }), makeParams("evt-1"));
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: "evt-1",
          action: "UPDATE",
          entityType: "Event",
        }),
      })
    );
  });
});

// ── DELETE Tests ──────────────────────────────────────────────────────────────

describe("PUT /api/events/[eventId] — maxAttendees (event-wide cap, Option B)", () => {
  beforeEach(() => vi.clearAllMocks());

  /** tx mock for the cap block: row lock ($queryRaw) → registration.count →
   *  event.update, all inside db.$transaction. */
  function setupCapTx(currentCount: number) {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "evt-1" }]),
      registration: { count: vi.fn().mockResolvedValue(currentCount) },
      event: { update: vi.fn().mockResolvedValue({}) },
    };
    (mockDb as unknown as { $transaction: unknown }).$transaction = vi.fn(
      async (cb: (t: unknown) => unknown) => cb(tx),
    );
    return tx;
  }

  it("sets the cap and RECOMPUTES seatCount from row-truth in the same tx", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(sampleEvent);
    mockDb.event.update.mockResolvedValue(sampleEvent);
    const tx = setupCapTx(40);

    const res = await PUT(makePutRequest({ maxAttendees: 100 }), makeParams("evt-1"));
    expect(res.status).toBe(200);
    expect(tx.event.update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: { maxAttendees: 100, seatCount: 40 },
    });
    // Recount excludes cancelled / virtual / companions and keeps null-source rows.
    expect(tx.registration.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        eventId: "evt-1",
        status: { not: "CANCELLED" },
        attendanceMode: "IN_PERSON",
        ticketTypeId: { not: null },
        OR: [{ createdSource: null }, { createdSource: { not: "SPEAKER_COMPANION" } }],
      }),
    });
  });

  it("rejects a cap below the current attendee count with 400 + the count", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(sampleEvent);
    const tx = setupCapTx(150);

    const res = await PUT(makePutRequest({ maxAttendees: 100 }), makeParams("evt-1"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("EVENT_CAP_BELOW_COUNT");
    expect(body.currentCount).toBe(150);
    expect(tx.event.update).not.toHaveBeenCalled();
  });

  it("maxAttendees 0 clears the cap to null (unlimited) — never blocked by the count", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(sampleEvent);
    mockDb.event.update.mockResolvedValue(sampleEvent);
    const tx = setupCapTx(5000);

    const res = await PUT(makePutRequest({ maxAttendees: 0 }), makeParams("evt-1"));
    expect(res.status).toBe(200);
    expect(tx.event.update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: { maxAttendees: null, seatCount: 5000 },
    });
  });

  it("a PUT without maxAttendees never touches the cap tx", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst
      .mockResolvedValueOnce(sampleEvent) // existing event
      .mockResolvedValueOnce(null); // slug dup check
    mockDb.event.update.mockResolvedValue(sampleEvent);
    const tx = setupCapTx(0);

    const res = await PUT(makePutRequest({ name: "Renamed Event" }), makeParams("evt-1"));
    expect(res.status).toBe(200);
    expect(tx.registration.count).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/events/[eventId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(makeDeleteRequest(), makeParams("evt-1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for REVIEWER role", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const res = await DELETE(makeDeleteRequest(), makeParams("evt-1"));
    expect(res.status).toBe(403);
  });

  it("returns 403 for SUBMITTER role", async () => {
    mockAuth.mockResolvedValue(submitterSession);
    const res = await DELETE(makeDeleteRequest(), makeParams("evt-1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when event not found", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await DELETE(makeDeleteRequest(), makeParams("evt-1"));
    expect(res.status).toBe(404);
  });

  it("deletes event successfully", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", name: "Test Event" });
    mockDb.event.delete.mockResolvedValue({});
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    const res = await DELETE(makeDeleteRequest(), makeParams("evt-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(mockDb.event.delete).toHaveBeenCalledWith({ where: { id: "evt-1" } });
  });

  it("returns 500 on database error", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", name: "Test" });
    mockDb.event.delete.mockRejectedValue(new Error("FK constraint"));

    const res = await DELETE(makeDeleteRequest(), makeParams("evt-1"));
    expect(res.status).toBe(500);
  });
});

// ── WEBINAR anchor cascade (Aug 4, 2026) ─────────────────────────────────────

describe("PUT /api/events/[eventId] — WEBINAR Settings date change cascades to the anchor", () => {
  const ANCHOR = {
    id: "anchor1",
    startTime: new Date("2026-06-01T10:00:00Z"),
    endTime: new Date("2026-06-01T11:30:00Z"), // 90 min
    updatedAt: new Date("2026-05-01T00:00:00Z"),
  };
  const webinarEvent = {
    ...sampleEvent,
    eventType: "WEBINAR",
    startDate: new Date("2026-06-01T10:00:00Z"),
    endDate: new Date("2026-06-01T11:30:00Z"),
    timezone: "Asia/Dubai",
    settings: { webinar: { sessionId: "anchor1" } },
  };

  beforeEach(() => {
    // This suite has no global clearAllMocks — reset the state these tests
    // depend on explicitly so calls/fixtures don't leak between cases.
    mockCascadeUpdateSession.mockReset();
    mockDb.event.update.mockClear();
    mockDb.eventSession.findMany.mockResolvedValue([]);
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(webinarEvent);
    mockDb.event.update.mockResolvedValue({ ...webinarEvent, id: "evt-1" });
    mockDb.eventSession.findFirst.mockResolvedValue(ANCHOR);
    mockCascadeUpdateSession.mockResolvedValue({ ok: true, session: { id: "anchor1" }, zoomSync: "synced", sequenceSync: "rescheduled" });
  });

  it("moves the anchor to the new start (duration preserved) and reports the cascade", async () => {
    const newStart = "2026-06-05T14:00:00.000Z";
    const res = await PUT(makePutRequest({ startDate: newStart, endDate: "2026-06-05T15:30:00.000Z" }), makeParams("evt-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.webinarTimeCascade).toEqual({ anchorMoved: true, zoomSync: "synced", sequenceSync: "rescheduled" });
    expect(mockCascadeUpdateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt-1",
        sessionId: "anchor1",
        startTime: new Date(newStart),
        // 90-minute anchor duration preserved at the new start.
        endTime: new Date(new Date(newStart).getTime() + 90 * 60_000),
        expectedUpdatedAt: ANCHOR.updatedAt,
        source: "rest",
      }),
    );
  });

  it("the anchor is exempt from the M9 out-of-range guard (it is about to be moved)", async () => {
    // The anchor still sits at the OLD date — without the exemption the guard
    // would 400 SESSIONS_OUTSIDE_NEW_DATES and the retime would be impossible.
    mockDb.eventSession.findMany.mockResolvedValue([
      { id: "anchor1", name: "Webinar", startTime: ANCHOR.startTime, endTime: ANCHOR.endTime },
    ]);
    const res = await PUT(
      makePutRequest({ startDate: "2026-06-05T14:00:00.000Z", endDate: "2026-06-05T15:30:00.000Z" }),
      makeParams("evt-1"),
    );
    expect(res.status).toBe(200);
  });

  it("OTHER out-of-range sessions still block the date change (guard intact)", async () => {
    mockDb.eventSession.findMany.mockResolvedValue([
      { id: "rogue-2", name: "Second Session", startTime: ANCHOR.startTime, endTime: ANCHOR.endTime },
    ]);
    const res = await PUT(
      makePutRequest({ startDate: "2026-06-05T14:00:00.000Z", endDate: "2026-06-05T15:30:00.000Z" }),
      makeParams("evt-1"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("SESSIONS_OUTSIDE_NEW_DATES");
    expect(mockCascadeUpdateSession).not.toHaveBeenCalled();
  });

  it("a CONFERENCE date change never cascades", async () => {
    mockDb.event.findFirst.mockResolvedValue({ ...webinarEvent, eventType: "CONFERENCE" });
    mockDb.event.update.mockResolvedValue({ ...webinarEvent, eventType: "CONFERENCE" });
    const res = await PUT(
      makePutRequest({ startDate: "2026-06-05T14:00:00.000Z", endDate: "2026-06-05T15:30:00.000Z" }),
      makeParams("evt-1"),
    );
    expect(res.status).toBe(200);
    expect(mockCascadeUpdateSession).not.toHaveBeenCalled();
    expect((await res.json()).webinarTimeCascade).toBeUndefined();
  });

  it("an unchanged start instant never cascades (General saves echo the same dates)", async () => {
    const res = await PUT(
      makePutRequest({ name: "Renamed", startDate: "2026-06-01T10:00:00.000Z", endDate: "2026-06-01T11:30:00.000Z" }),
      makeParams("evt-1"),
    );
    expect(res.status).toBe(200);
    expect(mockCascadeUpdateSession).not.toHaveBeenCalled();
  });

  it("400s ANCHOR_OUTSIDE_NEW_DATES BEFORE saving when the anchor's new window crosses past the new end date", async () => {
    // New start 23:30 Dubai on the event's last day; the anchor's preserved
    // 90-min duration ends it on the NEXT local day → the exemption + cascade
    // must not diverge, so the save is refused up front (review M4).
    const res = await PUT(
      makePutRequest({ startDate: "2026-06-05T19:30:00.000Z", endDate: "2026-06-05T19:59:00.000Z" }),
      makeParams("evt-1"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ANCHOR_OUTSIDE_NEW_DATES");
    expect(mockDb.event.update).not.toHaveBeenCalled();
    expect(mockCascadeUpdateSession).not.toHaveBeenCalled();
  });

  it("a failed cascade is isolated: event saves, response reports anchorMoved false", async () => {
    mockCascadeUpdateSession.mockResolvedValue({ ok: false, code: "STALE_WRITE", message: "conflict" });
    const res = await PUT(
      makePutRequest({ startDate: "2026-06-05T14:00:00.000Z", endDate: "2026-06-05T15:30:00.000Z" }),
      makeParams("evt-1"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).webinarTimeCascade).toEqual({ anchorMoved: false, reason: "STALE_WRITE" });
  });
});
