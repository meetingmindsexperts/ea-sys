/**
 * The wire from the new-event form to the event service for a webinar's video
 * source (Nov 12, 2026, review of 8bcf9cf8). Two things were unpinned: that
 * POST /api/events carries `webinarSource` to the service at all (drop the
 * schema line and zod strips it silently, so every "partner" webinar would get
 * a Zoom webinar), and that the choice is refused while a partner's key cannot
 * be issued yet. Since Nov 16, 2026 "can be issued" is the SERVER's answer
 * (partner-stream-readiness.ts), and the refusal is the event service's.
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
vi.mock("@/lib/webinar/partner-stream-readiness", () => ({
  partnerStreamReadiness: () =>
    flag.offered ? { ready: true, missing: [] } : { ready: false, missing: ["STREAM_PUBLISH_SECRET", "MEDIAMTX_CONTROL"] },
}));

import { POST } from "@/app/api/events/route";
import { GET as availabilityGET } from "@/app/api/events/partner-stream-availability/route";

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
  it("the service's refusal on a server that cannot issue a partner's key is a 400 with its code", async () => {
    // The refusal itself lives in the event service since Nov 16, 2026 (the AI agent creates
    // webinars too); event-service.test.ts pins it. The route only carries it.
    mockCreateEvent.mockResolvedValue({ ok: false, code: "PARTNER_STREAMS_NOT_AVAILABLE", message: "no" });
    const res = await POST(req({ eventType: "WEBINAR", webinarSource: "external" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("PARTNER_STREAMS_NOT_AVAILABLE");
    expect(readFileSync("src/app/api/events/route.ts", "utf8")).not.toContain("partnerStreamReadiness");
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

describe("the form offers the choice only where the server can issue a key", () => {
  it("the availability route answers yes or no, and never which setting is missing", async () => {
    expect(await (await availabilityGET()).json()).toEqual({ offered: false });
    flag.offered = true;
    expect(await (await availabilityGET()).json()).toEqual({ offered: true });
  });

  it("the form shows the field only on a yes, and sends a source only then", () => {
    const form = readFileSync("src/app/(dashboard)/events/new/page.tsx", "utf8");
    expect(form).toContain("usePartnerStreamAvailability()");
    expect(form).toMatch(/=== "WEBINAR" && partnerStreams\.data\?\.offered === true/);
    expect(form).toContain("webinarSource: isWebinar ? data.webinarSource : undefined");
    // The client form never reads the environment itself.
    expect(form).not.toContain("process.env");
  });
});
