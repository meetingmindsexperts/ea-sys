/**
 * provisionWebinar — M1 (program/agenda review): the read→create window used
 * to have no lock, so the event-create fire-and-forget racing the console's
 * "Re-run provisioner" could mint TWO anchor sessions + TWO billable Zoom
 * webinars. These tests pin the provisioning-sentinel claim: contended claims
 * back off, stale claims are reclaimable, a lost claim falls back to the
 * idempotent result, and the sentinel is always released (success + failure).
 *
 * `updateEventSettings` is mocked STATEFULLY — patches (object or function
 * form) apply to an in-test settings object, so the claim/release mechanics
 * run for real instead of being asserted as call shapes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockUpdateEventSettings, mockZoom, mockEnqueue, mockDeleteRemote, mockNotify, state } =
  vi.hoisted(() => {
    const state: { settings: Record<string, unknown> } = { settings: {} };
    return {
      state,
      mockDb: {
        event: { findUnique: vi.fn() },
        eventSession: { findFirst: vi.fn(), create: vi.fn() },
        zoomMeeting: { create: vi.fn(), findUnique: vi.fn() },
      },
      mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      mockUpdateEventSettings: vi.fn(),
      mockZoom: { isZoomConfigured: vi.fn(), createZoomWebinar: vi.fn() },
      mockEnqueue: vi.fn(async (...args: unknown[]) => void args),
      mockDeleteRemote: vi.fn(async (...args: unknown[]) => (void args, true)),
      mockNotify: vi.fn(async (...args: unknown[]) => void args),
    };
  });

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: mockUpdateEventSettings }));
vi.mock("@/lib/zoom", () => ({
  isZoomConfigured: (...a: unknown[]) => mockZoom.isZoomConfigured(...a),
  createZoomWebinar: (...a: unknown[]) => mockZoom.createZoomWebinar(...a),
}));
vi.mock("@/lib/webinar-email-sequence", () => ({
  enqueueWebinarSequenceForEvent: (...a: unknown[]) => mockEnqueue(...a),
}));
vi.mock("@/lib/zoom/cleanup", () => ({
  deleteRemoteZoomMeeting: (...a: unknown[]) => mockDeleteRemote(...a),
}));
vi.mock("@/lib/notifications", () => ({
  notifyEventAdmins: (...a: unknown[]) => mockNotify(...a),
}));

import { Prisma } from "@prisma/client";
import { provisionWebinar } from "@/lib/webinar-provisioner";

function p2002(): Error {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

const EVENT = {
  id: "ev1",
  name: "Cardio Webinar",
  startDate: new Date("2026-09-01T10:00:00Z"),
  endDate: new Date("2026-09-01T11:00:00Z"),
  timezone: "Asia/Dubai",
  description: null,
  slug: "cardio",
  organizationId: "org1",
};

function webinarSettings(): Record<string, unknown> | undefined {
  return state.settings.webinar as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = {};
  // Stateful settings store — object patch shallow-merges, function patch
  // replaces, exactly like the real helper.
  mockUpdateEventSettings.mockImplementation(
    async (_id: string, patch: unknown) => {
      state.settings =
        typeof patch === "function"
          ? (patch as (c: Record<string, unknown>) => Record<string, unknown>)(state.settings)
          : { ...state.settings, ...(patch as Record<string, unknown>) };
      return state.settings;
    },
  );
  // The db event read serves the CURRENT settings state.
  mockDb.event.findUnique.mockImplementation(async () => ({
    ...EVENT,
    settings: state.settings,
  }));
  mockDb.eventSession.create.mockResolvedValue({ id: "anchor1" });
  mockDb.eventSession.findFirst.mockResolvedValue(null);
  mockDb.zoomMeeting.findUnique.mockResolvedValue(null);
  mockZoom.isZoomConfigured.mockResolvedValue(false); // Zoom off ⇒ shorter happy path
});

describe("provisionWebinar — M1 sentinel claim", () => {
  it("wins a fresh claim, provisions, and clears the sentinel in the final write", async () => {
    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sessionId).toBe("anchor1");
    expect(mockDb.eventSession.create).toHaveBeenCalledTimes(1);
    const webinar = webinarSettings();
    expect(webinar?.sessionId).toBe("anchor1");
    // The claim marker must not survive a successful provision.
    expect(webinar?.provisioningAt).toBeUndefined();
  });

  it("backs off when another invocation holds a fresh claim (no second session)", async () => {
    state.settings = { webinar: { provisioningAt: new Date().toISOString() } };
    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("provision-already-in-progress");
    expect(mockDb.eventSession.create).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "ev1" }),
      "webinar:provision-claim-contended",
    );
  });

  it("reclaims a stale claim (crashed provision >10 min ago)", async () => {
    state.settings = {
      webinar: { provisioningAt: new Date(Date.now() - 20 * 60_000).toISOString() },
    };
    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(true);
    expect(mockDb.eventSession.create).toHaveBeenCalledTimes(1);
    expect(webinarSettings()?.provisioningAt).toBeUndefined();
  });

  it("lost claim (concurrent run finished first) → returns ITS session idempotently", async () => {
    // The db read sees no sessionId, but by claim time a concurrent run has
    // written one — the claim must NOT create a second session; the retry
    // takes the idempotent branch against the winner's session.
    state.settings = { webinar: { sessionId: "winner-session" } };
    mockDb.event.findUnique
      // First read: pre-claim snapshot WITHOUT the winner's sessionId.
      .mockResolvedValueOnce({ ...EVENT, settings: {} })
      // Retry read: fresh settings carrying the winner's sessionId.
      .mockImplementation(async () => ({ ...EVENT, settings: state.settings }));
    mockDb.eventSession.findFirst.mockResolvedValue({
      id: "winner-session",
      zoomMeeting: null,
    });

    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sessionId).toBe("winner-session");
    expect(mockDb.eventSession.create).not.toHaveBeenCalled();
  });

  it("a DANGLING sessionId (anchor deleted) does not read as already-provisioned — recovery still works", async () => {
    // Settings point at a session that no longer exists; the operator re-runs
    // the provisioner. The claim must treat the dangling pointer as
    // reclaimable, not as a concurrent win (which would loop / dead-end).
    state.settings = { webinar: { sessionId: "deleted-session" } };
    mockDb.eventSession.findFirst.mockResolvedValue(null); // dangling
    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sessionId).toBe("anchor1");
    expect(mockDb.eventSession.create).toHaveBeenCalledTimes(1);
    expect(webinarSettings()?.sessionId).toBe("anchor1");
  });

  it("releases the sentinel when provisioning fails after the claim", async () => {
    mockDb.eventSession.create.mockRejectedValue(new Error("db down"));
    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(false);
    // Cleanup ran: the failed run's claim must not force the next attempt to
    // wait out the 10-min stale window.
    expect(webinarSettings()?.provisioningAt).toBeUndefined();
  });

  it("does not touch another run's claim when failing BEFORE claiming", async () => {
    state.settings = { webinar: { provisioningAt: new Date().toISOString() } };
    // Contended → returns early. The other run's claim must survive.
    await provisionWebinar("ev1");
    expect(webinarSettings()?.provisioningAt).toBeTruthy();
  });

  it("final settings write merges over the locked current (concurrent lobby save survives)", async () => {
    // A lobby-message save lands while we provision; the function-form final
    // write must preserve it instead of clobbering with the pre-claim snapshot.
    mockDb.eventSession.create.mockImplementation(async () => {
      state.settings = {
        ...state.settings,
        webinar: {
          ...(state.settings.webinar as Record<string, unknown>),
          lobbyMessage: "saved mid-provision",
        },
      };
      return { id: "anchor1" };
    });
    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(true);
    const webinar = webinarSettings();
    expect(webinar?.lobbyMessage).toBe("saved mid-provision");
    expect(webinar?.sessionId).toBe("anchor1");
  });
});

describe("provisionWebinar — anchor Zoom re-attach (Aug 4, 2026)", () => {
  const ANCHOR = {
    id: "anchor1",
    startTime: new Date("2026-09-01T10:00:00Z"),
    endTime: new Date("2026-09-01T11:30:00Z"),
    zoomMeeting: null,
  };

  it("anchor without a Zoom webinar + Zoom configured → creates one on the ANCHOR (no new session)", async () => {
    state.settings = { webinar: { sessionId: "anchor1" } };
    mockDb.eventSession.findFirst.mockResolvedValue(ANCHOR);
    mockZoom.isZoomConfigured.mockResolvedValue(true);
    mockZoom.createZoomWebinar.mockResolvedValue({
      id: 555,
      join_url: "https://zoom.us/j/555",
      start_url: "https://zoom.us/s/555",
      password: "pw",
    });
    mockDb.zoomMeeting.create.mockResolvedValue({});
    mockDb.zoomMeeting.findUnique.mockResolvedValue({ zoomMeetingId: "555" });

    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.sessionId).toBe("anchor1");
      expect(res.zoomStatus).toBe("created");
      expect(res.zoomMeetingId).toBe("555");
    }
    // NO second anchor session — the whole point of the fix.
    expect(mockDb.eventSession.create).not.toHaveBeenCalled();
    // The webinar is created with the ANCHOR's own times (90 min), not the
    // event's default window.
    expect(mockZoom.createZoomWebinar).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({
        startTime: ANCHOR.startTime.toISOString(),
        duration: 90,
      }),
    );
    expect(mockDb.zoomMeeting.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sessionId: "anchor1", meetingType: "WEBINAR" }),
      }),
    );
    // Sequence enqueued now that a joinUrl exists.
    expect(mockEnqueue).toHaveBeenCalledWith("ev1", undefined);
  });

  it("anchor without Zoom + org has no Zoom configured → not-configured, nothing created", async () => {
    state.settings = { webinar: { sessionId: "anchor1" } };
    mockDb.eventSession.findFirst.mockResolvedValue(ANCHOR);
    mockZoom.isZoomConfigured.mockResolvedValue(false);

    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.zoomStatus).toBe("not-configured");
    expect(mockZoom.createZoomWebinar).not.toHaveBeenCalled();
    expect(mockDb.zoomMeeting.create).not.toHaveBeenCalled();
    expect(mockDb.eventSession.create).not.toHaveBeenCalled();
  });

  it("lost the sessionId-unique race → tears down its remote webinar, reports already-attached", async () => {
    state.settings = { webinar: { sessionId: "anchor1" } };
    mockDb.eventSession.findFirst.mockResolvedValue(ANCHOR);
    mockZoom.isZoomConfigured.mockResolvedValue(true);
    mockZoom.createZoomWebinar.mockResolvedValue({
      id: 777,
      join_url: "j",
      start_url: "s",
      password: "p",
    });
    mockDb.zoomMeeting.create.mockRejectedValue(p2002());
    mockDb.zoomMeeting.findUnique.mockResolvedValue({ zoomMeetingId: "666" });

    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.zoomStatus).toBe("already-attached");
    expect(mockDeleteRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        zoomMeetingId: "777",
        reason: "provision-reattach-conflict-rollback",
      }),
    );
  });

  it("anchor WITH a Zoom webinar keeps the pure idempotent no-op (no re-attach, no create)", async () => {
    state.settings = { webinar: { sessionId: "anchor1" } };
    mockDb.eventSession.findFirst.mockResolvedValue({
      ...ANCHOR,
      zoomMeeting: { id: "zm1", zoomMeetingId: "111" },
    });

    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.zoomStatus).toBe("already-attached");
      expect(res.zoomMeetingId).toBe("111");
    }
    expect(mockZoom.createZoomWebinar).not.toHaveBeenCalled();
    expect(mockDb.eventSession.create).not.toHaveBeenCalled();
  });
});

describe("provisionWebinar — re-attach failure discrimination (review M6)", () => {
  it("a TRANSIENT row-create failure reports failed (not already-attached) and still tears down", async () => {
    state.settings = { webinar: { sessionId: "anchor1" } };
    mockDb.eventSession.findFirst.mockResolvedValue({
      id: "anchor1",
      startTime: new Date("2026-09-01T10:00:00Z"),
      endTime: new Date("2026-09-01T11:00:00Z"),
      zoomMeeting: null,
    });
    mockZoom.isZoomConfigured.mockResolvedValue(true);
    mockZoom.createZoomWebinar.mockResolvedValue({ id: 888, join_url: "j", start_url: "s", password: "p" });
    mockDb.zoomMeeting.create.mockRejectedValue(new Error("Timed out fetching a new connection"));
    mockDb.zoomMeeting.findUnique.mockResolvedValue(null);

    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.zoomStatus).toBe("failed");
    // The just-minted remote webinar has no local row either way — torn down.
    expect(mockDeleteRemote).toHaveBeenCalledWith(
      expect.objectContaining({ zoomMeetingId: "888" }),
    );
    // The sentinel was released (next attempt doesn't wait out the stale window).
    expect((state.settings.webinar as Record<string, unknown>)?.provisioningAt).toBeUndefined();
  });

  it("a fresh concurrent claim makes the re-attach back off (review M7)", async () => {
    state.settings = {
      webinar: { sessionId: "anchor1", provisioningAt: new Date().toISOString() },
    };
    mockDb.eventSession.findFirst.mockResolvedValue({
      id: "anchor1",
      startTime: new Date("2026-09-01T10:00:00Z"),
      endTime: new Date("2026-09-01T11:00:00Z"),
      zoomMeeting: null,
    });
    mockZoom.isZoomConfigured.mockResolvedValue(true);

    const res = await provisionWebinar("ev1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("provision-already-in-progress");
    expect(mockZoom.createZoomWebinar).not.toHaveBeenCalled();
  });
});

describe("provisionWebinar — no-Zoom lifecycle (Aug 27, 2026)", () => {
  it("enqueues the reminder sequence AND alerts admins when Zoom is not configured", async () => {
    // Default beforeEach: isZoomConfigured=false + empty settings ⇒ fresh provision.
    const res = await provisionWebinar("ev1", { actorUserId: "u1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.zoomStatus).toBe("not-configured");
    // Reminders enqueue regardless of Zoom status (gated session-page link
    // renders without a Zoom room) — previously gated on zoomStatus==="created".
    expect(mockEnqueue).toHaveBeenCalledWith("ev1", "u1");
    // The missing room is no longer invisible to the organizer.
    expect(mockNotify).toHaveBeenCalledWith(
      "ev1",
      expect.objectContaining({ title: "Webinar needs a Zoom room" }),
    );
  });

  it("does NOT alert admins when the Zoom room was created", async () => {
    mockZoom.isZoomConfigured.mockResolvedValue(true);
    mockZoom.createZoomWebinar.mockResolvedValue({
      id: 123,
      join_url: "https://zoom.us/j/123",
      start_url: "https://zoom.us/s/123?zak=X",
      password: "pc",
    });
    mockDb.zoomMeeting.create.mockResolvedValue({ zoomMeetingId: "123" });

    const res = await provisionWebinar("ev1", { actorUserId: "u1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.zoomStatus).toBe("created");
    expect(mockEnqueue).toHaveBeenCalledWith("ev1", "u1");
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
