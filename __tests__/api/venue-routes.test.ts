/**
 * The venue gate with the REAL permission code: VENUE_EVENT_SLUGS (404 when the
 * event is not listed), sign-in, an organisation, events.read on the event, and
 * events.update for the event team's views.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAuth, mockDb, svc } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() } },
  svc: {
    getMyActivity: vi.fn().mockResolvedValue(null),
    saveMyActivity: vi.fn().mockResolvedValue({ ok: true }),
    listActivity: vi.fn().mockResolvedValue([]),
    createReport: vi.fn().mockResolvedValue({ ok: true }),
    listReports: vi.fn().mockResolvedValue([]),
    readVenueConfig: vi.fn().mockReturnValue({ filter: null, screens: null }),
    saveFilter: vi.fn().mockResolvedValue({}),
    VENUE_SAFETY_INBOX: "info@x.test",
  },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/services/venue-service", () => svc);

import { GET as myGET, PUT as myPUT } from "@/app/api/venue/[eventId]/activity/me/route";
import { GET as allGET } from "@/app/api/venue/[eventId]/activity/route";
import { PUT as configPUT } from "@/app/api/venue/[eventId]/config/route";
import { GET as reportsGET, POST as reportsPOST } from "@/app/api/venue/[eventId]/reports/route";

const EVENT = { id: "evt-1", slug: "ehc26", name: "EHC", startDate: new Date(), endDate: new Date(), venue: null, timezone: "Asia/Dubai", eventType: "CONFERENCE", settings: {}, organizationId: "org-1", staffAssignments: [] as { userId: string }[] };
const as = (role: string, organizationId: string | null = "org-1", grants: string[] = []) =>
  mockAuth.mockResolvedValue({ user: { id: `u-${role}`, role, organizationId, procurementPermissions: grants } });
const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const put = (handler: typeof myPUT, body: unknown) => handler(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify(body) }), params);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VENUE_EVENT_SLUGS", "ehc26");
  mockDb.event.findFirst.mockResolvedValue(EVENT);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/venue gate", () => {
  it("404 for everyone when the event is not listed in VENUE_EVENT_SLUGS", async () => {
    vi.stubEnv("VENUE_EVENT_SLUGS", "other-event");
    as("SUPER_ADMIN");
    expect((await myGET(new Request("http://localhost/x"), params)).status).toBe(404);
  });

  it("401 signed out, 403 for an org-null role", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await myGET(new Request("http://localhost/x"), params)).status).toBe(401);
    as("REGISTRANT", null);
    expect((await myGET(new Request("http://localhost/x"), params)).status).toBe(403);
  });

  it("looks the event up through the permission's own where (404 when it cannot be seen)", async () => {
    as("ADMIN");
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await myGET(new Request("http://localhost/x"), params)).status).toBe(404);
    expect(mockDb.event.findFirst.mock.calls[0][0].where).toMatchObject({ id: "evt-1", organizationId: "org-1" });
  });

  it.each([
    ["ADMIN", 200, 200],
    ["ORGANIZER", 200, 200],
    ["MEMBER", 200, 403],
  ])("%s: own activity %i, the team's view %i", async (role, own, team) => {
    as(role);
    expect((await put(myPUT, { sessions: 1 })).status).toBe(own);
    expect((await allGET(new Request("http://localhost/x"), params)).status).toBe(team);
  });

  it("saves the person's activity under the SESSION's user, never the body's", async () => {
    as("MEMBER");
    await put(myPUT, { uid: "someone-else" });
    expect(svc.saveMyActivity.mock.calls[0][0]).toEqual({ organizationId: "org-1", eventId: "evt-1", userId: "u-MEMBER" });
  });

  it("only the event team saves the language filter", async () => {
    as("MEMBER");
    expect((await put(configPUT, { filter: { on: false } })).status).toBe(403);
    expect(svc.saveFilter).not.toHaveBeenCalled();
  });

  it("only the event team lists the safety reports", async () => {
    as("MEMBER");
    expect((await reportsGET(new Request("http://localhost/x"), params)).status).toBe(403);
    as("ORGANIZER");
    expect((await reportsGET(new Request("http://localhost/x"), params)).status).toBe(200);
  });

  it("an editor of assigned events is on the team only for events they are assigned to (review L3)", async () => {
    as("MEMBER", "org-1", ["events.update@ASSIGNED"]);
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, staffAssignments: [{ userId: "u-MEMBER" }] });
    expect((await allGET(new Request("http://localhost/x"), params)).status).toBe(200);
    // only the caller's own assignment row is read
    expect(mockDb.event.findFirst.mock.calls[0][0].select.staffAssignments).toEqual({ where: { userId: "u-MEMBER" }, select: { userId: true } });
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, staffAssignments: [] });
    expect((await allGET(new Request("http://localhost/x"), params)).status).toBe(403);
  });

  it("caps reports at 20 an hour per person, each one emailed", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-rate-limit-test", role: "MEMBER", organizationId: "org-1" } });
    const post = () => reportsPOST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ reason: "Spam or selling" }) }), params);
    for (let i = 0; i < 20; i++) expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(429);
    expect(svc.createReport).toHaveBeenCalledTimes(20);
    expect(svc.createReport.mock.calls[0][0]).toEqual({ organizationId: "org-1", eventId: "evt-1", userId: "u-rate-limit-test" });
  });
});
