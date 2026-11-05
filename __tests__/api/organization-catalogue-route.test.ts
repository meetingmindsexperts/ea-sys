/**
 * /api/organization/catalogue: the Settings, Catalogue tab (Nov 5, 2026).
 * Pins that the settings are validated and saved whole under
 * `settings.catalogue`, that the GET hands back only the listing switch from
 * each event's settings, and that listing an event needs that event's own
 * settings key and a published status.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockOrgMerge, mockEventMerge, mockWarn } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    organization: { findUnique: vi.fn() },
    event: { findMany: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockOrgMerge: vi.fn(),
  mockEventMerge: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: mockWarn, error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/event-settings", () => ({ updateOrganizationSettings: mockOrgMerge, updateEventSettings: mockEventMerge }));

import { GET, PATCH, PUT } from "@/app/api/organization/catalogue/route";

const URL_ = "http://localhost/api/organization/catalogue";
const put = (body: unknown) => PUT(new Request(URL_, { method: "PUT", body: JSON.stringify(body) }));
const patch = (body: unknown) => PATCH(new Request(URL_, { method: "PATCH", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", organizationId: "org1" } });
  mockDb.organization.findUnique.mockResolvedValue({ name: "MM Group", settings: {}, companyEmail: "info@x.com", companyPhone: "+971 4 1" });
  mockDb.event.findMany.mockResolvedValue([]);
  mockDb.event.findFirst.mockResolvedValue({ id: "e1", status: "PUBLISHED" });
  mockDb.auditLog.create.mockResolvedValue({});
  mockOrgMerge.mockImplementation(async (_id: string, fn: (c: Record<string, unknown>) => Record<string, unknown>) => fn({ timezone: "Asia/Dubai" }));
  mockEventMerge.mockResolvedValue({});
});

describe("PUT /api/organization/catalogue", () => {
  it("saves the whole set under settings.catalogue, blanks as null, other settings kept", async () => {
    const res = await put({ headline: " Medical meetings ", intro: "", showStats: false, heroImage: "/uploads/media/2026/11/a.jpg" });
    expect(res.status).toBe(200);
    const merged = await mockOrgMerge.mock.results[0].value;
    expect(merged).toEqual({
      timezone: "Asia/Dubai",
      catalogue: { headline: "Medical meetings", intro: null, showStats: false, heroImage: "/uploads/media/2026/11/a.jpg" },
    });
    const body = await res.json();
    expect(body.settings.showStats).toBe(false);
    expect(body.settings.showTopics).toBe(true);
  });

  it.each([
    ["a photo outside the media library", { heroImage: "/uploads/../api/x" }],
    ["a javascript: photo", { heroImage: "javascript:alert(1)" }],
    ["a headline over the limit", { headline: "x".repeat(121) }],
    ["a contact email that is not one", { contactEmail: "call us" }],
    ["an unknown key", { theme: "dark" }],
  ])("refuses %s with a logged 400", async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(mockOrgMerge).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: "organization/catalogue:PUT invalid" }));
  });

  it("is refused for a role without org.settings", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org1" } });
    expect((await put({ headline: "x" })).status).toBe(403);
    expect(mockOrgMerge).not.toHaveBeenCalled();
  });
});

describe("GET /api/organization/catalogue", () => {
  it("returns the settings with defaults, the fallbacks, and only the listing switch per event", async () => {
    mockDb.organization.findUnique.mockResolvedValue({
      name: "MM Group",
      settings: { catalogue: { headline: "Hello" }, stripe: { secret: "enc:s" } },
      companyEmail: "info@x.com",
      companyPhone: null,
    });
    mockDb.event.findMany.mockResolvedValue([
      { id: "e1", name: "A", slug: "a", status: "PUBLISHED", startDate: new Date(), endDate: new Date(), city: null, country: null, settings: { showInCatalogue: true, zoom: { secret: "z" } } },
    ]);
    const body = await (await GET(new Request(URL_))).json();
    expect(body.settings.headline).toBe("Hello");
    expect(body.settings.showNextUp).toBe(true);
    expect(body.defaults).toEqual({ organizationName: "MM Group", companyEmail: "info@x.com", companyPhone: null });
    expect(body.events[0].listed).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/enc:s|secret/);
    // Scoped to the caller's organisation and to statuses a catalogue can show.
    expect(mockDb.event.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org1", status: { in: ["PUBLISHED", "LIVE", "COMPLETED"] } } }));
  });
});

describe("PATCH /api/organization/catalogue (one event's listing)", () => {
  it("sets showInCatalogue through the locked event merge, within the organisation, and audits it", async () => {
    const res = await patch({ eventId: "e1", listed: true });
    expect(res.status).toBe(200);
    expect(mockEventMerge).toHaveBeenCalledWith("e1", expect.any(Function), { organizationId: "org1" });
    expect(mockEventMerge.mock.calls[0][1]({ other: 1 })).toEqual({ other: 1, showInCatalogue: true });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventId: "e1", entityType: "Event" }) }));
  });

  it("refuses to list a draft, logged", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "e1", status: "DRAFT" });
    expect((await patch({ eventId: "e1", listed: true })).status).toBe(409);
    expect(mockEventMerge).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: "organization/catalogue:PATCH not-listable" }));
  });

  it("still lets a draft be unlisted", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "e1", status: "DRAFT" });
    expect((await patch({ eventId: "e1", listed: false })).status).toBe(200);
  });

  it("answers 404 for an event outside the caller's reach", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await patch({ eventId: "other", listed: true })).status).toBe(404);
    expect(mockEventMerge).not.toHaveBeenCalled();
  });

  it("is refused for a role without events.settings", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org1" } });
    expect((await patch({ eventId: "e1", listed: true })).status).toBe(403);
  });

  it("refuses a malformed body with a logged 400", async () => {
    expect((await patch({ eventId: "e1", listed: "yes" })).status).toBe(400);
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: "organization/catalogue:PATCH invalid" }));
  });
});
