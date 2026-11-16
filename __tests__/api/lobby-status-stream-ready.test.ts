/**
 * lobby-status's `streamReady` (review of fbaf43f2): the public, cached poll says whether the session
 * has a stream at all, so the attendee page can ask zoom-join once more when a partner's key is issued
 * after the room opened. It must never carry the key itself: the HLS address contains it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/db", () => ({ db: { eventSession: { findFirst: h.findFirst } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: h.logger }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere: async () => ({ slug: "evt", organizationId: "org1" }) }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));

import { GET } from "@/app/api/public/events/[slug]/sessions/[sessionId]/lobby-status/route";

const KEY = "0123456789abcdef0123456789abcdef";
let n = 0;
/** A fresh session id per call, so the route's 3-second cache never answers for an earlier test. */
const call = () => GET({ headers: new Headers() } as unknown as Request, { params: Promise.resolve({ slug: "evt", sessionId: `s${++n}` }) });
const session = (extra: Record<string, unknown>) => ({
  status: "LIVE",
  startTime: new Date(Date.now() - 600_000),
  endTime: new Date(Date.now() + 3600_000),
  event: { status: "PUBLISHED", eventType: "WEBINAR", settings: { webinar: { sessionId: "s1", source: "external", viewingMode: "hls" } } },
  zoomMeeting: null,
  externalStream: null,
  ...extra,
});

beforeEach(() => vi.clearAllMocks());

describe("lobby-status streamReady", () => {
  it("false for a partner's webinar whose key is not issued yet", async () => {
    h.findFirst.mockResolvedValue(session({}));
    expect((await (await call()).json()).streamReady).toBe(false);
  });

  it("true once the partner's key exists, and the key itself is never in the answer", async () => {
    h.findFirst.mockResolvedValue(session({ externalStream: { streamKey: KEY, streamStatus: "IDLE" } }));
    const body = await (await call()).json();
    expect(body.streamReady).toBe(true);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(body).not.toHaveProperty("externalStream");
    expect(body).not.toHaveProperty("zoomMeeting");
  });

  it("true for our own Zoom webinar with live streaming on", async () => {
    h.findFirst.mockResolvedValue(
      session({ zoomMeeting: { liveStreamEnabled: true, streamKey: KEY, streamStatus: "IDLE" } }),
    );
    const body = await (await call()).json();
    expect(body.streamReady).toBe(true);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
});
