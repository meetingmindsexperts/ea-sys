/**
 * Stop stream is a choice, not a drop (Nov 5, 2026): the livestream POST remembers it so the stream
 * watchdog leaves the stream alone, Start clears it, and both land on the stream timeline.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, controlSpy, settingsSpy, recordSpy } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() }, eventSession: { findFirst: vi.fn() } },
  controlSpy: vi.fn(),
  settingsSpy: vi.fn(),
  recordSpy: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/webinar/livestream", () => ({ controlWebinarLiveStream: controlSpy, rtmpIngestUrl: () => "rtmp://x/live/" }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: settingsSpy }));
vi.mock("@/lib/webinar/stream-timeline", () => ({ recordStreamEvent: recordSpy }));

import { POST } from "@/app/api/events/[eventId]/webinar/livestream/route";

const call = (action: string) =>
  POST({ json: async () => ({ action }), headers: new Headers() } as unknown as Request, { params: Promise.resolve({ eventId: "ev1" }) });

/** The settings the route writes, from a starting webinar block. */
const written = (start: Record<string, unknown>) => {
  const fn = settingsSpy.mock.calls[0][1] as (c: Record<string, unknown>) => { webinar: Record<string, unknown> };
  return fn({ webinar: start }).webinar;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", slug: "web", settings: { webinar: { sessionId: "s1" } } });
  mockDb.eventSession.findFirst.mockResolvedValue({ name: "Webinar" });
  settingsSpy.mockResolvedValue({});
  controlSpy.mockImplementation(async ({ action }: { action: string }) => ({ ok: true, action, streamKey: "sk" }));
});

describe("POST /webinar/livestream: producer intent", () => {
  it("Stop stream records the stop, so the watchdog does not restart it", async () => {
    expect((await call("stop")).status).toBe(200);
    expect(typeof written({ sessionId: "s1" }).streamStoppedAt).toBe("string");
    expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: "STREAM_STOP_PRESSED", userId: "u1", sessionId: "s1" }));
  });

  it("Start stream clears it", async () => {
    await call("start");
    expect(written({ sessionId: "s1", streamStoppedAt: "2026-11-05T08:00:00Z" }).streamStoppedAt).toBeNull();
    expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: "STREAM_START_PRESSED" }));
  });

  it("re-sending the settings (sync) changes neither", async () => {
    await call("sync");
    expect(settingsSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("a Zoom refusal records nothing", async () => {
    controlSpy.mockResolvedValue({ ok: false, code: "ZOOM_API_FAILED", message: "no" });
    expect((await call("stop")).status).toBe(502);
    expect(settingsSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
