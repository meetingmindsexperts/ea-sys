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

const { mockDb, mockApiLogger, mockUpdateEventSettings, mockZoom, mockEnqueue, state } =
  vi.hoisted(() => {
    const state: { settings: Record<string, unknown> } = { settings: {} };
    return {
      state,
      mockDb: {
        event: { findUnique: vi.fn() },
        eventSession: { findFirst: vi.fn(), create: vi.fn() },
        zoomMeeting: { create: vi.fn() },
      },
      mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      mockUpdateEventSettings: vi.fn(),
      mockZoom: { isZoomConfigured: vi.fn(), createZoomWebinar: vi.fn() },
      mockEnqueue: vi.fn(async (...args: unknown[]) => void args),
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

import { provisionWebinar } from "@/lib/webinar-provisioner";

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
