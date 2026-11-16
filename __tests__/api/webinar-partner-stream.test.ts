/**
 * The console's Partner stream routes (Nov 16, 2026; external streams step 5).
 * What is pinned: a key exists only on a webinar streamed by a partner; the
 * key itself comes from one audited route and only for "See Zoom host
 * details"; a refusal from the service keeps its reason and gets the right
 * status; a failed disconnect is reported, not hidden.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockDb: { event: { findFirst: vi.fn() } },
  canSpy: vi.fn(),
  rate: { allowed: true },
  svc: {
    getExternalStream: vi.fn(),
    externalStreamSignal: vi.fn(),
    issueExternalStream: vi.fn(),
    replaceExternalStreamKey: vi.fn(),
    cutExternalStream: vi.fn(),
    setExternalStreamEnabled: vi.fn(),
    updateExternalStreamDetails: vi.fn(),
    revealExternalStreamCredentials: vi.fn(),
  },
  ready: { value: true },
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
vi.mock("@/lib/permissions/can", () => ({ can: (...args: unknown[]) => h.canSpy(...args) }));
vi.mock("@/lib/webinar/partner-stream-readiness", () => ({
  partnerStreamReadiness: () => ({ ready: h.ready.value, missing: h.ready.value ? [] : ["MEDIAMTX_CONTROL"] }),
}));
vi.mock("@/services/external-stream-service", () => h.svc);

import { GET, POST, PATCH } from "@/app/api/events/[eventId]/webinar/partner-stream/route";
import { POST as keyPOST } from "@/app/api/events/[eventId]/webinar/partner-stream/credentials/route";

const ctx = { params: Promise.resolve({ eventId: "ev1" }) };
const req = (body?: unknown) => ({ json: async () => body } as unknown as Request);

const PARTNER_EVENT = { id: "ev1", eventType: "WEBINAR", settings: { webinar: { sessionId: "s1", source: "external" } } };
const VIEW = {
  id: "x1",
  sessionId: "s1",
  enabled: true,
  secretVersion: 1,
  validFrom: new Date("2027-01-01T00:00:00Z"),
  validUntil: new Date("2027-01-21T12:00:00Z"),
  validUntilIsOwn: false,
  issuedTo: "Agency",
  lastPublishAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.rate.allowed = true;
  h.ready.value = true;
  h.mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  h.mockDb.event.findFirst.mockResolvedValue(PARTNER_EVENT);
  h.canSpy.mockReturnValue(true);
  h.svc.getExternalStream.mockResolvedValue(VIEW);
  h.svc.externalStreamSignal.mockResolvedValue("not-receiving");
  for (const fn of ["issueExternalStream", "replaceExternalStreamKey", "cutExternalStream", "setExternalStreamEnabled", "updateExternalStreamDetails"] as const) {
    h.svc[fn].mockResolvedValue({ ok: true, externalStream: VIEW });
  }
});

describe("GET partner-stream", () => {
  it("answers the state, the signal and whether this person may see the key, never the key", async () => {
    h.canSpy.mockReturnValue(false);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ partnerStream: VIEW, signal: "not-receiving", serverReady: true, canSeeKey: false });
    expect(JSON.stringify(body)).not.toMatch(/streamKey|pass=/);
    expect(h.svc.getExternalStream).toHaveBeenCalledWith({ eventId: "ev1", sessionId: "s1" });
  });

  it("a webinar on our own Zoom has no partner stream: refused and logged", async () => {
    h.mockDb.event.findFirst.mockResolvedValue({ ...PARTNER_EVENT, settings: { webinar: { sessionId: "s1" } } });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_PARTNER_SOURCE");
    expect(h.mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1" }), "webinar-partner-stream:not-a-partner-webinar");
    expect(h.svc.getExternalStream).not.toHaveBeenCalled();
  });

  it("a conference is refused the same way", async () => {
    h.mockDb.event.findFirst.mockResolvedValue({ ...PARTNER_EVENT, eventType: "CONFERENCE" });
    expect((await GET(req(), ctx)).status).toBe(409);
  });

  it("an event outside the caller's grant is a 404", async () => {
    h.mockDb.event.findFirst.mockResolvedValue(null);
    expect((await GET(req(), ctx)).status).toBe(404);
  });

  it("no anchor session yet: the producer is told to run the provisioner", async () => {
    h.mockDb.event.findFirst.mockResolvedValue({ ...PARTNER_EVENT, settings: { webinar: { source: "external" } } });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("NO_ANCHOR_SESSION");
    expect(body.error).toContain("Re-run provisioner");
  });
});

describe("POST partner-stream", () => {
  it("issues with who it was given to and an end date, as a Date", async () => {
    const res = await POST(req({ action: "issue", issuedTo: "Agency", validUntil: "2027-01-21T12:00:00.000Z" }), ctx);
    expect(res.status).toBe(200);
    expect(h.svc.issueExternalStream).toHaveBeenCalledWith({
      organizationId: "org1",
      eventId: "ev1",
      sessionId: "s1",
      userId: "u1",
      source: "rest",
      issuedTo: "Agency",
      validUntil: new Date("2027-01-21T12:00:00.000Z"),
    });
  });

  it("each button reaches its own operation", async () => {
    await POST(req({ action: "replace" }), ctx);
    await POST(req({ action: "cut" }), ctx);
    await POST(req({ action: "switch-on" }), ctx);
    expect(h.svc.replaceExternalStreamKey).toHaveBeenCalledTimes(1);
    expect(h.svc.cutExternalStream).toHaveBeenCalledTimes(1);
    expect(h.svc.setExternalStreamEnabled).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("a disconnect that failed is reported with its reason (the key DID change)", async () => {
    h.svc.cutExternalStream.mockResolvedValue({
      ok: true,
      externalStream: { ...VIEW, enabled: false },
      disconnect: { ok: false, code: "UNREACHABLE", message: "The stream server did not answer." },
    });
    const body = await (await POST(req({ action: "cut" }), ctx)).json();
    expect(body.disconnect).toEqual({ ok: false, error: "The stream server did not answer." });
    expect(body.partnerStream.enabled).toBe(false);
  });

  it.each([
    ["PUBLISH_SECRET_NOT_SET", 503],
    ["CONTROL_API_NOT_SET", 503],
    ["ALREADY_ISSUED", 409],
    ["ZOOM_WEBINAR_EXISTS", 409],
    ["NOT_ISSUED", 404],
    ["INVALID_PERIOD", 400],
  ])("the service's %s keeps its words and answers %i", async (code, status) => {
    h.svc.issueExternalStream.mockResolvedValue({ ok: false, code, message: `because ${code}` });
    const res = await POST(req({ action: "issue" }), ctx);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: `because ${code}`, code });
  });

  it("an unknown action, or an end date that is not a date, is a logged 400", async () => {
    expect((await POST(req({ action: "delete" }), ctx)).status).toBe(400);
    expect((await POST(req({ action: "issue", validUntil: "tomorrow" }), ctx)).status).toBe(400);
    expect(h.mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1" }), "webinar-partner-stream:validation-failed");
    expect(h.svc.issueExternalStream).not.toHaveBeenCalled();
  });

  it("rate limited: 429 with the time to wait", async () => {
    h.rate.allowed = false;
    const res = await POST(req({ action: "cut" }), ctx);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ retryAfterSeconds: 60 });
    expect(h.svc.cutExternalStream).not.toHaveBeenCalled();
  });
});

describe("PATCH partner-stream", () => {
  it("null makes the key follow the session again", async () => {
    await PATCH(req({ validUntil: null }), ctx);
    expect(h.svc.updateExternalStreamDetails).toHaveBeenCalledWith(expect.objectContaining({ validUntil: null, issuedTo: undefined }));
  });

  it("an empty change is refused", async () => {
    expect((await PATCH(req({}), ctx)).status).toBe(400);
    expect(h.svc.updateExternalStreamDetails).not.toHaveBeenCalled();
  });
});

describe("POST partner-stream/credentials", () => {
  it("without 'See Zoom host details' it is refused, logged, and the service is never asked", async () => {
    h.canSpy.mockReturnValue(false);
    const res = await keyPOST(req(), ctx);
    expect(res.status).toBe(403);
    expect(h.mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "webinar-partner-stream:key-refused-no-host-permission");
    expect(h.svc.revealExternalStreamCredentials).not.toHaveBeenCalled();
  });

  it("with it, the key is returned uncached, from the one audited function", async () => {
    h.svc.revealExternalStreamCredentials.mockResolvedValue({
      ok: true,
      credentials: { serverUrl: "rtmp://events.example/live/", streamKey: "k?user=publisher&pass=p" },
    });
    const res = await keyPOST(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ "Cache-Control": "no-store" });
    expect((await res.json()).credentials.serverUrl).toBe("rtmp://events.example/live/");
    expect(h.canSpy).toHaveBeenCalledWith({ userId: "u1" }, "zoomHost.view");
  });

  it("on our own Zoom webinar there is no partner key to show", async () => {
    h.mockDb.event.findFirst.mockResolvedValue({ ...PARTNER_EVENT, settings: { webinar: { sessionId: "s1", source: "zoom" } } });
    expect((await keyPOST(req(), ctx)).status).toBe(409);
    expect(h.svc.revealExternalStreamCredentials).not.toHaveBeenCalled();
  });
});

describe("the shown key does not outlive its use (reviews of d86921d4 and 20265a35)", () => {
  it("a replaced key remounts the reveal, and the answer is not kept in the mutation cache", async () => {
    const { readFileSync } = await import("node:fs");
    const card = readFileSync("src/components/webinar/partner-stream-card.tsx", "utf8");
    // Keyed by the version: after Replace the old, dead value cannot stay on screen to be copied.
    expect(card).toMatch(/<KeyReveal\s+key=\{stream\.secretVersion\}/);
    const hooks = readFileSync("src/hooks/use-api.ts", "utf8");
    const reveal = hooks.slice(hooks.indexOf("export function useRevealWebinarPartnerStreamKey"));
    expect(reveal.slice(0, reveal.indexOf("\n}\n"))).toContain("gcTime: 0");
  });
});

