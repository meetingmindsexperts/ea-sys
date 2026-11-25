/**
 * The console's recording route for a partner's stream (Nov 25, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md step 3). What is pinned: only on a
 * partner's webinar; each press reaches the one service call with the caller
 * it needs (the organisation for a start, the reason "staff" for a finish);
 * the partner's agreement is passed through, never assumed; a refusal keeps
 * its reason and gets the right status; a stream server that did not take the
 * change is reported inside a success, never as a failure; nothing about the
 * key or the files is answered.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockDb: { event: { findFirst: vi.fn() } },
  rate: { allowed: true },
  svc: {
    getStreamRecording: vi.fn(),
    startStreamRecording: vi.fn(),
    stopStreamRecording: vi.fn(),
    finishStreamRecording: vi.fn(),
    streamRecordingAvailable: vi.fn(),
    deleteStreamRecording: vi.fn(),
    streamRecordingDownload: vi.fn(),
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => h.mockAuth() }));
vi.mock("@/lib/logger", () => ({ apiLogger: h.mockLogger }));
vi.mock("@/lib/db", () => ({ db: h.mockDb }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: h.rate.allowed, retryAfterSeconds: 60 }) }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: () => ({ ok: true, principal: { userId: "u1" }, eventWhere: { id: "ev1", organizationId: "org1" } }),
}));
vi.mock("@/services/stream-recording-service", () => h.svc);

import { GET, POST, DELETE } from "@/app/api/events/[eventId]/webinar/partner-stream/recording/route";
import { POST as downloadPOST } from "@/app/api/events/[eventId]/webinar/partner-stream/recording/download/route";

const ctx = { params: Promise.resolve({ eventId: "ev1" }) };
const req = (body?: unknown) => ({ json: async () => body } as unknown as Request);

const PARTNER_EVENT = { id: "ev1", eventType: "WEBINAR", slug: "beta-webinar", settings: { webinar: { sessionId: "s1", source: "external" } } };
const VIEW = {
  id: "r1",
  sessionId: "s1",
  status: "RECORDING",
  partnerAgreedAt: new Date("2027-01-21T09:00:00Z"),
  startedAt: new Date("2027-01-21T09:00:00Z"),
  lastStartedAt: new Date("2027-01-21T09:00:00Z"),
  stoppedAt: null,
  finishedAt: null,
  segmentCount: 10,
  totalBytes: 12_000_000,
  durationMs: 60_000,
  lastPieceAt: new Date("2027-01-21T09:01:00Z"),
  hasArchive: false,
  archiveBytes: null,
  error: null,
  deleteAfter: new Date("2028-01-21T09:00:00Z"),
};
const CALLER = { organizationId: "org1", eventId: "ev1", sessionId: "s1", userId: "u1", source: "rest" };

beforeEach(() => {
  vi.clearAllMocks();
  h.rate.allowed = true;
  h.mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  h.mockDb.event.findFirst.mockResolvedValue(PARTNER_EVENT);
  h.svc.streamRecordingAvailable.mockReturnValue(true);
  h.svc.getStreamRecording.mockResolvedValue(null);
  for (const fn of ["startStreamRecording", "stopStreamRecording", "finishStreamRecording"] as const) {
    h.svc[fn].mockResolvedValue({ ok: true, recording: VIEW, server: { ok: true, changed: true } });
  }
});

describe("GET partner-stream/recording", () => {
  it("answers whether recording is offered and the recording, and nothing about the key or the files", async () => {
    h.svc.getStreamRecording.mockResolvedValue(VIEW);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ available: true, recording: VIEW });
    expect(JSON.stringify(body)).not.toMatch(/streamKey|storagePrefix|storedPath|archivePath/);
    expect(h.svc.getStreamRecording).toHaveBeenCalledWith({ eventId: "ev1", sessionId: "s1" });
  });

  it("shows a recording already made with the switch off, so it can still be finished", async () => {
    h.svc.streamRecordingAvailable.mockReturnValue(false);
    h.svc.getStreamRecording.mockResolvedValue(VIEW);
    expect(await (await GET(req(), ctx)).json()).toEqual({ available: false, recording: VIEW });
  });

  it("a webinar on our own Zoom has none: refused before the service is asked", async () => {
    h.mockDb.event.findFirst.mockResolvedValue({ ...PARTNER_EVENT, settings: { webinar: { sessionId: "s1" } } });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_PARTNER_SOURCE");
    expect(h.svc.getStreamRecording).not.toHaveBeenCalled();
  });
});

describe("POST partner-stream/recording", () => {
  it("Start names the organisation and passes the partner's agreement as given", async () => {
    const res = await POST(req({ action: "start", partnerAgreed: true }), ctx);
    expect(res.status).toBe(200);
    expect(h.svc.startStreamRecording).toHaveBeenCalledWith({ ...CALLER, partnerAgreed: true });
    expect(await res.json()).toEqual({ recording: VIEW, server: { ok: true } });
  });

  it("Start without the tick is not taken as agreed", async () => {
    await POST(req({ action: "start" }), ctx);
    expect(h.svc.startStreamRecording).toHaveBeenCalledWith({ ...CALLER, partnerAgreed: undefined });
  });

  it("Stop and Finish reach their own calls; Finish says it was staff", async () => {
    await POST(req({ action: "stop" }), ctx);
    expect(h.svc.stopStreamRecording).toHaveBeenCalledWith(CALLER);
    await POST(req({ action: "finish" }), ctx);
    expect(h.svc.finishStreamRecording).toHaveBeenCalledWith({ ...CALLER, reason: "staff" });
  });

  it("a stream server that did not take the change is reported inside the success", async () => {
    h.svc.stopStreamRecording.mockResolvedValue({
      ok: true,
      recording: VIEW,
      server: { ok: false, code: "UNREACHABLE", message: "The stream server did not answer." },
    });
    const res = await POST(req({ action: "stop" }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).server).toEqual({ ok: false, error: "The stream server did not answer." });
  });

  it.each([
    ["AGREEMENT_REQUIRED", 400],
    ["NOT_STARTED", 404],
    ["ALREADY_FINISHED", 409],
    ["NOT_PARTNER_STREAM", 409],
    ["DISK_LOW", 503],
    ["NOT_AVAILABLE", 503],
  ])("a refusal %s keeps its reason, status %i", async (code, status) => {
    h.svc.startStreamRecording.mockResolvedValue({ ok: false, code, message: `because ${code}` });
    const res = await POST(req({ action: "start", partnerAgreed: true }), ctx);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: `because ${code}`, code });
  });

  it("an unknown action is refused and logged, before anything is asked", async () => {
    const res = await POST(req({ action: "delete" }), ctx);
    expect(res.status).toBe(400);
    expect(h.mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1" }), "webinar-stream-recording:validation-failed");
    expect(h.mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("is rate limited and says so", async () => {
    h.rate.allowed = false;
    const res = await POST(req({ action: "stop" }), ctx);
    expect(res.status).toBe(429);
    expect(h.mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1" }), "webinar-stream-recording:rate-limited");
    expect(h.svc.stopStreamRecording).not.toHaveBeenCalled();
  });
});

// Step 4 (Nov 25, 2026): delete and download.
describe("DELETE partner-stream/recording", () => {
  it("deletes as staff and says whether files were left", async () => {
    h.svc.deleteStreamRecording.mockResolvedValue({ ok: true, filesLeft: 0 });
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, filesLeft: 0 });
    expect(h.svc.deleteStreamRecording).toHaveBeenCalledWith({ ...CALLER, reason: "staff" });
  });

  it.each([
    ["STILL_RECORDING", 409],
    ["STILL_PREPARING", 409],
    ["NOT_STARTED", 404],
  ])("a refusal %s keeps its reason, status %i", async (code, status) => {
    h.svc.deleteStreamRecording.mockResolvedValue({ ok: false, code, message: `because ${code}` });
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });

  it("only on a partner's webinar", async () => {
    h.mockDb.event.findFirst.mockResolvedValue({ ...PARTNER_EVENT, settings: { webinar: { sessionId: "s1" } } });
    expect((await DELETE(req(), ctx)).status).toBe(409);
    expect(h.svc.deleteStreamRecording).not.toHaveBeenCalled();
  });
});

describe("POST partner-stream/recording/download", () => {
  it("answers the signed link, never the file, and names the event for the file name", async () => {
    h.svc.streamRecordingDownload.mockResolvedValue({ ok: true, url: "https://bucket.example/signed", fileName: "beta-webinar-recording.mp4" });
    const res = await downloadPOST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://bucket.example/signed", fileName: "beta-webinar-recording.mp4" });
    expect(h.svc.streamRecordingDownload).toHaveBeenCalledWith({ ...CALLER, eventSlug: "beta-webinar" });
  });

  it("no file is a 404 with the reason", async () => {
    h.svc.streamRecordingDownload.mockResolvedValue({ ok: false, code: "NO_FILE", message: "no file" });
    const res = await downloadPOST(req(), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NO_FILE");
  });

  it("no bucket to sign for (local storage) is said, and logged", async () => {
    h.svc.streamRecordingDownload.mockResolvedValue({ ok: true, url: null, fileName: "x.mp4" });
    const res = await downloadPOST(req(), ctx);
    expect(res.status).toBe(501);
    expect(h.mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1" }), "webinar-stream-recording:download-no-signed-link");
  });

  it("is rate limited per person and says so", async () => {
    h.rate.allowed = false;
    const res = await downloadPOST(req(), ctx);
    expect(res.status).toBe(429);
    expect(h.svc.streamRecordingDownload).not.toHaveBeenCalled();
  });
});
