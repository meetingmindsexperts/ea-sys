/**
 * Agenda CSV import — service-delegation parity (July 20, 2026).
 *
 * The route used to be a raw `db.eventSession.create` loop that predated the
 * July 16 session-service extraction, silently drifting from the canonical
 * create path: no event-timezone date validation (a wrong-year CSV imported
 * fine, then blocked Settings date edits via SESSIONS_OUTSIDE_NEW_DATES), no
 * audit rows, pre-counted track sortOrder, negative capacity persisted.
 * These tests pin the delegation: every row goes through
 * `session-service.createSession()` (per-row notifications suppressed, ONE
 * batch summary), service rejections become row errors without aborting the
 * batch, and new tracks get max+1 sortOrder inside a transaction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockCreateSession, mockNotify, mockApiLogger } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    track: { findMany: vi.fn() },
    speaker: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  mockAuth: vi.fn(),
  mockCreateSession: vi.fn(),
  mockNotify: vi.fn(),
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/event-access", () => ({ buildEventAccessWhere: () => ({ id: "ev1" }) }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: mockNotify }));
vi.mock("@/services/session-service", () => ({ createSession: mockCreateSession }));

import { POST } from "@/app/api/events/[eventId]/import/sessions/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };

function csvRequest(csv: string): Request {
  const fd = new FormData();
  fd.append("file", new File([csv], "sessions.csv", { type: "text/csv" }));
  return new Request("http://localhost/api/events/ev1/import/sessions", { method: "POST", body: fd });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.track.findMany.mockResolvedValue([{ id: "trk-main", name: "Main" }]);
  mockDb.speaker.findMany.mockResolvedValue([
    { id: "spk-1", email: "jane@example.com" },
    { id: "spk-2", email: "john@example.com" },
  ]);
  mockCreateSession.mockResolvedValue({ ok: true, session: { id: "s-new" } });
  mockNotify.mockResolvedValue(undefined);
});

describe("agenda CSV import delegates to session-service", () => {
  it("routes each row through createSession with suppressed per-row notifications", async () => {
    const csv = [
      "name,startTime,endTime,track,speakerEmails,capacity,status",
      "Keynote,2026-03-15T09:00:00Z,2026-03-15T10:00:00Z,Main,jane@example.com;john@example.com,100,SCHEDULED",
    ].join("\n");

    const res = await POST(csvRequest(csv), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.created).toBe(1);
    expect(body.errors).toEqual([]);
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    const call = mockCreateSession.mock.calls[0][0];
    expect(call).toMatchObject({
      eventId: "ev1",
      userId: "u1",
      source: "rest",
      requestIp: "1.2.3.4",
      name: "Keynote",
      trackId: "trk-main",
      speakerIds: ["spk-1", "spk-2"],
      capacity: 100,
      status: "SCHEDULED",
      suppressAdminNotification: true,
    });
    expect(call.startTime).toBeInstanceOf(Date);
    expect(call.endTime).toBeInstanceOf(Date);
  });

  it("turns a service rejection (OUTSIDE_EVENT_DATES) into a row error without aborting the batch", async () => {
    mockCreateSession
      .mockResolvedValueOnce({
        ok: false,
        code: "OUTSIDE_EVENT_DATES",
        message: "Session must fall within event dates (2026-03-15 to 2026-03-17 Asia/Dubai)",
      })
      .mockResolvedValueOnce({ ok: true, session: { id: "s2" } });

    const csv = [
      "name,startTime,endTime",
      "Wrong Year,2025-03-15T09:00:00Z,2025-03-15T10:00:00Z",
      "Good One,2026-03-15T09:00:00Z,2026-03-15T10:00:00Z",
    ].join("\n");

    const res = await POST(csvRequest(csv), params);
    const body = await res.json();

    expect(body.created).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain("Row 2");
    expect(body.errors[0]).toContain("within event dates");
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
  });

  it("sends ONE summary notification for the batch (none per row, none on all-failed)", async () => {
    const csv = [
      "name,startTime,endTime",
      "A,2026-03-15T09:00:00Z,2026-03-15T10:00:00Z",
      "B,2026-03-15T11:00:00Z,2026-03-15T12:00:00Z",
    ].join("\n");

    await POST(csvRequest(csv), params);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][1].message).toContain("2 sessions imported");

    // All rows rejected → no summary notification either.
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
    mockDb.track.findMany.mockResolvedValue([]);
    mockDb.speaker.findMany.mockResolvedValue([]);
    mockCreateSession.mockResolvedValue({ ok: false, code: "OUTSIDE_EVENT_DATES", message: "nope" });
    await POST(csvRequest(csv), params);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("creates a missing track with max+1 sortOrder inside a transaction", async () => {
    const txTrack = {
      aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 4 } }),
      create: vi.fn().mockResolvedValue({ id: "trk-new", name: "Cardiology" }),
    };
    mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ track: txTrack }));

    const csv = [
      "name,startTime,endTime,track",
      "Session X,2026-03-15T09:00:00Z,2026-03-15T10:00:00Z,Cardiology",
    ].join("\n");

    const res = await POST(csvRequest(csv), params);
    const body = await res.json();

    expect(body.tracksCreated).toBe(1);
    expect(txTrack.create).toHaveBeenCalledWith({
      data: { eventId: "ev1", name: "Cardiology", sortOrder: 5 },
    });
    expect(mockCreateSession.mock.calls[0][0].trackId).toBe("trk-new");
  });

  it("capacity leniency: 0 / negative / garbage import as uncapped (null), never persisted", async () => {
    const csv = [
      "name,startTime,endTime,capacity",
      "A,2026-03-15T09:00:00Z,2026-03-15T10:00:00Z,0",
      "B,2026-03-15T11:00:00Z,2026-03-15T12:00:00Z,-5",
      "C,2026-03-15T13:00:00Z,2026-03-15T14:00:00Z,lots",
    ].join("\n");

    await POST(csvRequest(csv), params);
    expect(mockCreateSession).toHaveBeenCalledTimes(3);
    for (const call of mockCreateSession.mock.calls) {
      expect(call[0].capacity).toBeNull();
    }
  });

  it("unknown speaker email → row error, session still created with the resolved speakers", async () => {
    const csv = [
      "name,startTime,endTime,speakerEmails",
      "A,2026-03-15T09:00:00Z,2026-03-15T10:00:00Z,jane@example.com;ghost@example.com",
    ].join("\n");

    const res = await POST(csvRequest(csv), params);
    const body = await res.json();

    expect(body.created).toBe(1);
    expect(body.errors[0]).toContain('speaker "ghost@example.com" not found');
    expect(mockCreateSession.mock.calls[0][0].speakerIds).toEqual(["spk-1"]);
  });
});
