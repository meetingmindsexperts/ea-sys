/**
 * The webinar email sequence route (Nov 25, 2026; owner: "make it manual, let the organiser decide
 * what is the sequence"): GET shows the plan beside the rows, PUT saves the organiser's choices and
 * schedules them, POST schedules the plan as it stands. Both writes confirm the plan.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, permSpy, mockLimit, settingsSpy, rescheduleSpy, scheduledSpy } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    scheduledEmail: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  permSpy: vi.fn(),
  mockLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  settingsSpy: vi.fn(),
  rescheduleSpy: vi.fn(),
  scheduledSpy: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => mockLimit() }));
vi.mock("@/lib/permissions/require-permission", () => ({ requirePermission: (_s: unknown, key: string) => permSpy(key) }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: settingsSpy }));
vi.mock("@/lib/webinar-email-sequence", () => ({ rescheduleWebinarSequenceForEvent: rescheduleSpy, isSequenceScheduled: scheduledSpy }));
vi.mock("@/lib/bulk-email", () => ({ WEBINAR_EMAIL_TYPES: ["webinar-confirmation", "webinar-thank-you"] }));

import { GET, POST, PUT } from "@/app/api/events/[eventId]/webinar/sequence/route";
import { defaultPhaseChoices } from "@/lib/webinar-sequence-plan";

const ctx = () => ({ params: Promise.resolve({ eventId: "ev1" }) });
const put = (body: unknown) => PUT(new Request("http://t/x", { method: "PUT", body: JSON.stringify(body) }), ctx());

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  permSpy.mockReturnValue({ ok: true, principal: { organizationId: "org1", baseRole: "ADMIN", fromApiKey: false }, eventWhere: { id: "ev1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: { webinar: { sessionId: "s1" } } });
  mockDb.scheduledEmail.findMany.mockResolvedValue([]);
  mockDb.auditLog.create.mockReturnValue(Promise.resolve({}));
  settingsSpy.mockResolvedValue({});
  rescheduleSpy.mockResolvedValue({ ok: true, created: 4, cleared: 0, skipped: null });
  scheduledSpy.mockResolvedValue(false);
});

describe("GET", () => {
  it("shows the plan, pre-filled with the usual five, and whether it is scheduled", async () => {
    const body = await (await GET(new Request("http://t/x"), ctx())).json();
    expect(body.plan).toEqual({ phases: defaultPhaseChoices(), scheduled: false });
    expect(permSpy).toHaveBeenCalledWith("webinar.analytics.read");
  });
});

describe("PUT", () => {
  it("saves the organiser's choices as confirmed, then schedules them (an explicit action may revive a cancelled one)", async () => {
    const phases = { ...defaultPhaseChoices(), "webinar-reminder-1h": { enabled: false, minutes: 60 } };
    const res = await put({ phases });
    expect(res.status).toBe(200);
    expect(permSpy).toHaveBeenCalledWith("webinar.manage");
    const patch = settingsSpy.mock.calls[0][1] as (cur: Record<string, unknown>) => Record<string, unknown>;
    const next = patch({ other: 1, webinar: { sessionId: "s1", viewingMode: "hls" } });
    expect(next).toEqual({ other: 1, webinar: { sessionId: "s1", viewingMode: "hls", sequence: { confirmed: true, phases } } });
    expect(rescheduleSpy).toHaveBeenCalledWith("ev1", "u1", { resurrectCancelled: true });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "WEBINAR_SEQUENCE_SCHEDULED" }) }));
    expect(await res.json()).toMatchObject({ created: 4 });
  });

  it("refuses a bad plan, no permission, an event out of reach, and too many writes, and changes nothing", async () => {
    expect((await put({ phases: { "webinar-live-now": { enabled: true, minutes: 0 } } })).status).toBe(400);
    permSpy.mockReturnValueOnce({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await put({ phases: defaultPhaseChoices() })).status).toBe(403);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await put({ phases: defaultPhaseChoices() })).status).toBe(404);
    mockLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 30 });
    const limited = await put({ phases: defaultPhaseChoices() });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED", limit: 30, windowSeconds: 3600 });
    expect(settingsSpy).not.toHaveBeenCalled();
    expect(rescheduleSpy).not.toHaveBeenCalled();
  });
});

describe("POST (the old Re-enqueue)", () => {
  it("schedules the plan as it stands, and that confirms it", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      settings: { webinar: { sessionId: "s1", sequence: { confirmed: false, phases: { "webinar-thank-you": { enabled: true, minutes: 30 } } } } },
    });
    const res = await POST(new Request("http://t/x", { method: "POST" }), ctx());
    expect(res.status).toBe(200);
    const patch = settingsSpy.mock.calls[0][1] as (cur: Record<string, unknown>) => { webinar: { sequence: { confirmed: boolean; phases: Record<string, { minutes: number }> } } };
    const next = patch({ webinar: {} });
    expect(next.webinar.sequence.confirmed).toBe(true);
    expect(next.webinar.sequence.phases["webinar-thank-you"].minutes).toBe(30);
    expect(rescheduleSpy).toHaveBeenCalledWith("ev1", "u1", { resurrectCancelled: true });
  });
});
