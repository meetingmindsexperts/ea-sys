/**
 * The console's stream preview (Oct 2, 2026) reads the HLS address from the
 * livestream GET. The address is the stream key, so only the Zoom host roles
 * get it, and it is null until the anchor session has a stream set up.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    zoomMeeting: { findFirst: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/event-access", () => ({ buildEventAccessWhere: () => ({ id: "ev1" }) }));
vi.mock("@/lib/webinar/livestream", () => ({
  controlWebinarLiveStream: vi.fn(),
  rtmpIngestUrl: () => "rtmp://box:1935/live/",
}));

import { GET } from "@/app/api/events/[eventId]/webinar/livestream/route";

const call = () => GET({} as Request, { params: Promise.resolve({ eventId: "ev1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://events.example.com";
  delete process.env.HLS_CDN_BASE;
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "WEBINARS", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: { webinar: { sessionId: "anchor1" } } });
  mockDb.zoomMeeting.findFirst.mockResolvedValue({ streamKey: "sk1" });
});

describe("GET /webinar/livestream: preview address", () => {
  it("gives a Zoom host role the HLS address of the anchor session's stream", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rtmpIngestUrl: "rtmp://box:1935/live/",
      hlsPreviewUrl: "https://events.example.com/stream/live/sk1/index.m3u8",
    });
    expect(mockDb.zoomMeeting.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: "anchor1", eventId: "ev1", liveStreamEnabled: true } }),
    );
  });

  it("is null while the stream is not set up", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
    expect((await (await call()).json()).hlsPreviewUrl).toBeNull();
  });

  it("refuses a read-only MEMBER (the address is the stream key)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "MEMBER", organizationId: "org1" } });
    const res = await call();
    expect(res.status).toBe(403);
    expect(mockDb.zoomMeeting.findFirst).not.toHaveBeenCalled();
  });
});
