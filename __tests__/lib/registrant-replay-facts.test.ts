/**
 * A webinar's replay in the person's portal (registrant-replays.ts, Nov 10, 2026): which
 * registrations get a Watch replay button on My events, and what /my-account/replay/{eventId}
 * shows.
 *
 * Three existing rules composed, all run for real here over a mocked database: WHOSE registration
 * (registrant-access.ts), in good standing (viewer-entitlement.ts), WHICH replay (webinar/replay.ts).
 * The event's status plays no part: the public webinar page stops answering once an event is marked
 * Completed, and this page is where its replay stays watchable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    registration: { findMany: vi.fn(), findFirst: vi.fn() },
    eventSession: { findMany: vi.fn(), findFirst: vi.fn() },
    event: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { buildJourney } from "@/lib/registrant-journey";
import { loadPortalReplay, loadReplayFacts } from "@/lib/registrant-replays";

const NOW = new Date("2026-11-10T12:00:00Z");
const ENDED = new Date("2026-11-10T08:30:00Z");
const VIMEO = "https://vimeo.com/123456789";
const EMBED = "https://player.vimeo.com/video/123456789?dnt=1";
const confirmed = { userId: "u1", email: "dr@hospital.com", confirmed: true };
const unconfirmed = { userId: "u1", email: "dr@hospital.com", confirmed: false };

const webinar = (id: string) => ({ id: `r-${id}`, event: { id, eventType: "WEBINAR" } });
const STARTED = new Date("2026-11-10T07:30:00Z");
const UPCOMING = new Date("2026-12-01T18:00:00Z");
const entitledRow = (
  eventId: string,
  webinarSettings: Record<string, unknown>,
  id = `r-${eventId}`,
  event: { status: string; endDate: Date } = { status: "PUBLISHED", endDate: ENDED },
) => ({
  id,
  eventId,
  event: { settings: { webinar: webinarSettings }, ...event },
});
const anchor = (eventId: string, over: Record<string, unknown> = {}) => ({
  id: `s-${eventId}`, eventId, status: "COMPLETED", startTime: STARTED, endTime: ENDED, zoomMeeting: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.findMany.mockResolvedValue([entitledRow("w1", { sessionId: "s-w1", showRecording: true, replayUrl: VIMEO })]);
  mockDb.eventSession.findMany.mockResolvedValue([anchor("w1")]);
});

describe("who may watch in the portal: own registration, in good standing, on a webinar", () => {
  const whereOf = async (scope: typeof confirmed) => {
    await loadReplayFacts(scope, [webinar("w1"), webinar("w2"), webinar("w1")], NOW);
    return mockDb.registration.findMany.mock.calls[0][0].where;
  };

  it("a confirmed account: registrations linked to it, or unlinked ones on its address", async () => {
    const where = await whereOf(confirmed);
    expect(where.eventId).toEqual({ in: ["w1", "w2"] });
    expect(where.event).toEqual({ eventType: "WEBINAR" });
    const [own, standing] = where.AND;
    expect(own).toEqual({
      OR: [{ userId: "u1" }, { userId: null, attendee: { email: { equals: "dr@hospital.com", mode: "insensitive" } } }],
    });
    // Confirmed or checked in, and paid or nothing owed: the rule for watching live.
    expect(standing.status).toEqual({ in: ["CONFIRMED", "CHECKED_IN"] });
    expect(standing.OR[0]).toEqual({ paymentStatus: { in: ["PAID", "COMPLIMENTARY", "INCLUSIVE"] } });
  });

  it("an account that has not proven its address: linked registrations only, never by address", async () => {
    const where = await whereOf(unconfirmed);
    expect(where.AND[0]).toEqual({ userId: "u1" });
    expect(JSON.stringify(where)).not.toContain("dr@hospital.com");
  });
});

describe("loadReplayFacts", () => {
  it("an entitled registration on a webinar with an uploaded replay is marked", async () => {
    expect([...(await loadReplayFacts(confirmed, [webinar("w1")], NOW))]).toEqual(["r-w1"]);
  });

  it("no webinars among the events: no query at all", async () => {
    const replays = await loadReplayFacts(confirmed, [{ id: "r1", event: { id: "c1", eventType: "CONFERENCE" } }], NOW);
    expect(replays.size).toBe(0);
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
    expect(mockDb.eventSession.findMany).not.toHaveBeenCalled();
  });

  it("nobody entitled (pending, unpaid, cancelled): nothing, and no session read", async () => {
    mockDb.registration.findMany.mockResolvedValue([]);
    expect((await loadReplayFacts(confirmed, [webinar("w1")], NOW)).size).toBe(0);
    expect(mockDb.eventSession.findMany).not.toHaveBeenCalled();
  });

  it("the organiser's switch off, or a webinar still to end: no button", async () => {
    mockDb.registration.findMany.mockResolvedValue([entitledRow("w1", { sessionId: "s-w1", replayUrl: VIMEO })]);
    expect((await loadReplayFacts(confirmed, [webinar("w1")], NOW)).size).toBe(0);

    mockDb.registration.findMany.mockResolvedValue([entitledRow("w1", { sessionId: "s-w1", showRecording: true, replayUrl: VIMEO })]);
    mockDb.eventSession.findMany.mockResolvedValue([anchor("w1", { status: "LIVE" })]);
    expect((await loadReplayFacts(confirmed, [webinar("w1")], NOW)).size).toBe(0);
  });

  it("Zoom's fetched recording counts as a replay too, and an unfetched one does not", async () => {
    mockDb.registration.findMany.mockResolvedValue([entitledRow("w1", { sessionId: "s-w1", showRecording: true })]);
    mockDb.eventSession.findMany.mockResolvedValue([anchor("w1", { zoomMeeting: { recordingStatus: "AVAILABLE" } })]);
    expect([...(await loadReplayFacts(confirmed, [webinar("w1")], NOW))]).toEqual(["r-w1"]);
    mockDb.eventSession.findMany.mockResolvedValue([anchor("w1", { zoomMeeting: { recordingStatus: "PENDING" } })]);
    expect((await loadReplayFacts(confirmed, [webinar("w1")], NOW)).size).toBe(0);
  });

  it("a stale anchor pointer never borrows another event's session", async () => {
    // w1 points at w2's session, which has a fetched Zoom recording. w1 has no link and is not
    // over, so the only way it could show a replay is by borrowing that session.
    mockDb.registration.findMany.mockResolvedValue([
      entitledRow("w1", { sessionId: "s-w2", showRecording: true }, "r-w1", { status: "PUBLISHED", endDate: UPCOMING }),
    ]);
    mockDb.eventSession.findMany.mockResolvedValue([anchor("w2", { zoomMeeting: { recordingStatus: "AVAILABLE" } })]);
    expect((await loadReplayFacts(confirmed, [webinar("w1")], NOW)).size).toBe(0);
  });

  it("a webinar with NO session of its own (most on production): the event answers, with no session read", async () => {
    // Completed, link saved, switch on: the case the console used to confirm and nobody could watch.
    const noSession = { showRecording: true, replayUrl: VIMEO };
    mockDb.registration.findMany.mockResolvedValue([entitledRow("w1", noSession, "r-w1", { status: "COMPLETED", endDate: ENDED })]);
    expect([...(await loadReplayFacts(confirmed, [webinar("w1")], NOW))]).toEqual(["r-w1"]);
    expect(mockDb.eventSession.findMany).not.toHaveBeenCalled();

    // Not over yet, or the switch off: nothing.
    mockDb.registration.findMany.mockResolvedValue([entitledRow("w1", noSession, "r-w1", { status: "PUBLISHED", endDate: UPCOMING })]);
    expect((await loadReplayFacts(confirmed, [webinar("w1")], NOW)).size).toBe(0);
    mockDb.registration.findMany.mockResolvedValue([entitledRow("w1", { replayUrl: VIMEO }, "r-w1", { status: "COMPLETED", endDate: ENDED })]);
    expect((await loadReplayFacts(confirmed, [webinar("w1")], NOW)).size).toBe(0);
  });

  it("a pointer to a session that is gone is treated the same way: the event answers", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      entitledRow("w1", { sessionId: "deleted", showRecording: true, replayUrl: VIMEO }, "r-w1", { status: "COMPLETED", endDate: ENDED }),
    ]);
    mockDb.eventSession.findMany.mockResolvedValue([]);
    expect([...(await loadReplayFacts(confirmed, [webinar("w1")], NOW))]).toEqual(["r-w1"]);
  });

  it("two webinars, one with a replay: only that one; two registrations on it both get it", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      entitledRow("w1", { sessionId: "s-w1", showRecording: true, replayUrl: VIMEO }, "r-a"),
      entitledRow("w1", { sessionId: "s-w1", showRecording: true, replayUrl: VIMEO }, "r-b"),
      entitledRow("w2", { sessionId: "s-w2", showRecording: true }, "r-c"),
    ]);
    mockDb.eventSession.findMany.mockResolvedValue([anchor("w1"), anchor("w2")]);
    expect([...(await loadReplayFacts(confirmed, [webinar("w1"), webinar("w2")], NOW))]).toEqual(["r-a", "r-b"]);
  });

  it("never reads the Event table directly: the settings ride on the registration read (event lane ratchet)", async () => {
    await loadReplayFacts(confirmed, [webinar("w1")], NOW);
    for (const fn of Object.values(mockDb.event)) expect(fn).not.toHaveBeenCalled();
    expect(mockDb.registration.findMany.mock.calls[0][0].select).toEqual({
      id: true,
      eventId: true,
      event: { select: { settings: true, status: true, endDate: true } },
    });
  });
});

describe("loadPortalReplay: what /my-account/replay/{eventId} shows", () => {
  const eventRow = (webinarSettings: Record<string, unknown>) => ({
    id: "w1", name: "Best of EHA", slug: "best-of-eha", startDate: ENDED, endDate: ENDED, timezone: "Asia/Dubai", status: "COMPLETED",
    settings: { webinar: { sessionId: "s-w1", ...webinarSettings }, reviewerUserIds: ["secret"] },
  });
  const ZOOM = { recordingStatus: "AVAILABLE", recordingUrl: "https://zoom.us/rec/play/1", recordingPassword: "pw" };

  beforeEach(() => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", event: eventRow({ showRecording: true, replayUrl: VIMEO }) });
    mockDb.eventSession.findFirst.mockResolvedValue(anchor("w1"));
  });

  it("the uploaded replay: the player address and the event, never the event's settings", async () => {
    const replay = await loadPortalReplay(confirmed, "w1", NOW);
    expect(replay).toEqual({
      state: "embed",
      embedUrl: EMBED,
      event: { id: "w1", name: "Best of EHA", slug: "best-of-eha", startDate: ENDED, endDate: ENDED, timezone: "Asia/Dubai" },
    });
    expect(JSON.stringify(replay)).not.toContain("reviewerUserIds");
  });

  it("asks for this person's own registration in good standing on THIS webinar", async () => {
    await loadPortalReplay(confirmed, "w1", NOW);
    const where = mockDb.registration.findFirst.mock.calls[0][0].where;
    expect(where.eventId).toBe("w1");
    expect(where.event).toEqual({ eventType: "WEBINAR" });
    expect(where.AND[0].OR[0]).toEqual({ userId: "u1" });
    expect(where.AND[1].status).toEqual({ in: ["CONFIRMED", "CHECKED_IN"] });
    // The anchor is read bound to the event.
    expect(mockDb.eventSession.findFirst.mock.calls[0][0].where).toEqual({ id: "s-w1", eventId: "w1" });
  });

  it("no such registration: says only that, with nothing about the event and no session read", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    expect(await loadPortalReplay(confirmed, "w1", NOW)).toEqual({ state: "not-registered" });
    expect(mockDb.eventSession.findFirst).not.toHaveBeenCalled();
  });

  it("the event's status is no gate: a webinar marked Completed still plays", async () => {
    // The public webinar page answers only for DRAFT, PUBLISHED and LIVE events. This one must not.
    expect((await loadPortalReplay(confirmed, "w1", NOW)).state).toBe("embed");
    const where = mockDb.registration.findFirst.mock.calls[0][0].where;
    expect(where.event).toEqual({ eventType: "WEBINAR" });
    expect(JSON.stringify(where)).not.toContain("PUBLISHED");
    expect(JSON.stringify(where)).not.toContain("DRAFT");
  });

  it("Zoom's recording when there is no upload: its link and passcode", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", event: eventRow({ showRecording: true }) });
    mockDb.eventSession.findFirst.mockResolvedValue(anchor("w1", { zoomMeeting: ZOOM }));
    expect(await loadPortalReplay(confirmed, "w1", NOW)).toMatchObject({ state: "zoom", url: ZOOM.recordingUrl, password: "pw" });
  });

  it("the upload wins over Zoom's recording, whose link and passcode are then not handed over", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue(anchor("w1", { zoomMeeting: ZOOM }));
    const replay = await loadPortalReplay(confirmed, "w1", NOW);
    expect(replay.state).toBe("embed");
    expect(JSON.stringify(replay)).not.toContain("zoom.us");
  });

  it("switched on, nothing uploaded or fetched: none, and one is expected", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", event: eventRow({ showRecording: true }) });
    expect(await loadPortalReplay(confirmed, "w1", NOW)).toMatchObject({ state: "none", expected: true });
  });

  it("the organiser's switch off: none, and none is promised, upload and Zoom recording or not", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", event: eventRow({ replayUrl: VIMEO }) });
    mockDb.eventSession.findFirst.mockResolvedValue(anchor("w1", { zoomMeeting: ZOOM }));
    const replay = await loadPortalReplay(confirmed, "w1", NOW);
    expect(replay).toMatchObject({ state: "none", expected: false });
    expect(JSON.stringify(replay)).not.toMatch(/vimeo|zoom\.us/);
  });

  it("a link saved before the webinar is over plays nothing yet", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue(anchor("w1", { status: "LIVE" }));
    expect(await loadPortalReplay(confirmed, "w1", NOW)).toMatchObject({ state: "none", expected: true });
  });

  it("a stored link that is not a Vimeo video is never handed to the player", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", event: eventRow({ showRecording: true, replayUrl: "https://evil.example/p" }) });
    const replay = await loadPortalReplay(confirmed, "w1", NOW);
    expect(replay.state).toBe("none");
    expect(JSON.stringify(replay)).not.toContain("evil.example");
  });

  it("a Zoom recording marked fetched but with no link: none, never an empty button", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", event: eventRow({ showRecording: true }) });
    mockDb.eventSession.findFirst.mockResolvedValue(anchor("w1", { zoomMeeting: { ...ZOOM, recordingUrl: null } }));
    expect((await loadPortalReplay(confirmed, "w1", NOW)).state).toBe("none");
  });

  it("no session of its own, or the session gone: the event answers (Completed here, so it plays)", async () => {
    const noSession = { ...eventRow({}), settings: { webinar: { showRecording: true, replayUrl: VIMEO } } };
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", event: noSession });
    expect(await loadPortalReplay(confirmed, "w1", NOW)).toMatchObject({ state: "embed", embedUrl: EMBED });
    expect(mockDb.eventSession.findFirst).not.toHaveBeenCalled();

    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", event: eventRow({ showRecording: true, replayUrl: VIMEO }) });
    mockDb.eventSession.findFirst.mockResolvedValue(null);
    expect((await loadPortalReplay(confirmed, "w1", NOW)).state).toBe("embed");
  });

  it("no session and the event not over: not ready yet, never a replay before the webinar", async () => {
    const upcoming = { ...eventRow({}), status: "PUBLISHED", endDate: UPCOMING, settings: { webinar: { showRecording: true, replayUrl: VIMEO } } };
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", event: upcoming });
    expect(await loadPortalReplay(confirmed, "w1", NOW)).toMatchObject({ state: "none", expected: true });
  });

  it("the event's status never reaches the page: it is read for the rule only", async () => {
    expect(JSON.stringify(await loadPortalReplay(confirmed, "w1", NOW))).not.toContain("COMPLETED");
  });
});

describe("buildJourney: the replay step", () => {
  const registration = {
    id: "r1", status: "CONFIRMED", paymentStatus: "COMPLIMENTARY", groupId: null, attendanceMode: "VIRTUAL",
    originalPrice: null, discountAmount: null, surveyCompletedAt: null, pricingTier: null, ticketType: { name: "Delegate", price: 0 },
  } as unknown as Parameters<typeof buildJourney>[0]["registration"];
  const event = { endDate: ENDED, eventType: "WEBINAR", status: "COMPLETED" };
  const labels = (replay?: boolean) =>
    buildJourney({ registration, event, surveys: [], certificateCount: 1, replay, now: NOW }).map((s) => `${s.key}:${s.label}:${s.state}`);

  it("sits after payment and before the certificate, as a word and a state", () => {
    expect(labels(true)).toEqual([
      "registered:Registered:done",
      "payment:Complimentary:done",
      "replay:Replay ready:done",
      "certificate:Certificate ready:done",
    ]);
  });

  it("is absent unless this registration may watch a replay now", () => {
    expect(labels(false).join()).not.toContain("replay");
    expect(labels(undefined).join()).not.toContain("replay");
  });
});
