/**
 * The wire from the new-event form to the event service for a webinar's video
 * source (Nov 12, 2026, review of 8bcf9cf8). Two things were unpinned: that
 * POST /api/events carries `webinarSource` to the service at all (drop the
 * schema line and zod strips it silently, so every "partner" webinar would get
 * a Zoom webinar), and that the choice is refused while a partner's key cannot
 * be issued yet.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockCreateEvent, mockLogger, flag } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCreateEvent: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  flag: { offered: false },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/api-key", () => ({ validateApiKey: vi.fn() }));
vi.mock("@/services/event-service", () => ({ createEvent: mockCreateEvent }));
vi.mock("@/lib/webinar/partner-stream-availability", () => ({
  get PARTNER_STREAM_CHOICE_OFFERED() {
    return flag.offered;
  },
  PARTNER_STREAM_NOT_OFFERED_MESSAGE: "not yet",
}));

import { POST } from "@/app/api/events/route";

const req = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Partner webinar",
      startDate: "2027-01-20T10:00:00.000Z",
      endDate: "2027-01-20T11:00:00.000Z",
      ...body,
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  flag.offered = false;
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockCreateEvent.mockResolvedValue({ ok: true, event: { id: "ev1", name: "Partner webinar", slug: "partner-webinar" } });
});

describe("POST /api/events: a webinar's video source", () => {
  it("while a partner's key cannot be issued yet, the partner choice is REFUSED, not quietly made a Zoom webinar", async () => {
    const res = await POST(req({ eventType: "WEBINAR", webinarSource: "external" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("PARTNER_STREAMS_NOT_AVAILABLE");
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "events:partner-stream-not-offered" }));
  });

  it("an ordinary webinar, and one that says 'zoom', are created as before", async () => {
    expect((await POST(req({ eventType: "WEBINAR" }))).status).toBe(201);
    expect((await POST(req({ eventType: "WEBINAR", webinarSource: "zoom" }))).status).toBe(201);
    expect(mockCreateEvent.mock.calls.map((c) => c[0].webinarSource)).toEqual([null, "zoom"]);
  });

  it("once offered, the choice reaches the event service", async () => {
    flag.offered = true;
    const res = await POST(req({ eventType: "WEBINAR", webinarSource: "external" }));
    expect(res.status).toBe(201);
    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "WEBINAR", webinarSource: "external" }));
  });

  it("an unknown source is a validation error", async () => {
    flag.offered = true;
    const res = await POST(req({ eventType: "WEBINAR", webinarSource: "teams" }));
    expect(res.status).toBe(400);
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });
});

describe("the choice is not offered before a partner's key can be issued", () => {
  it("the switch is off, and the form shows the field only behind it", () => {
    expect(readFileSync("src/lib/webinar/partner-stream-availability.ts", "utf8")).toContain(
      "export const PARTNER_STREAM_CHOICE_OFFERED = false;",
    );
    const form = readFileSync("src/app/(dashboard)/events/new/page.tsx", "utf8");
    expect(form).toMatch(/=== "WEBINAR" && PARTNER_STREAM_CHOICE_OFFERED/);
    expect(form).toContain("webinarSource: isWebinar ? data.webinarSource : undefined");
  });
});
