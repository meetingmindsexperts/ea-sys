/**
 * The staff preview of the public agenda (Nov 17, 2026). Who may open it is the
 * route matrix's job (sessions-program); this pins what the answer carries:
 * never cacheable, never indexed, and the published flag the page's preview
 * bar reads. The public route answers `public, max-age=60`; an unpublished
 * programme in a shared cache would be the leak this route exists to avoid.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.fn();
const mockRequirePermission = vi.fn();
const mockFindGatedEvent = vi.fn();
const mockLoadAgendaEvent = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
}));
vi.mock("@/lib/tenant/event-tenant", () => ({
  findGatedEvent: (...args: unknown[]) => mockFindGatedEvent(...args),
}));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/agenda-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agenda-data")>()),
  loadAgendaEvent: (...args: unknown[]) => mockLoadAgendaEvent(...args),
}));

import { GET } from "@/app/api/events/[eventId]/agenda-preview/route";

const call = () => GET(new Request("http://localhost/api/events/ev1/agenda-preview"), { params: Promise.resolve({ eventId: "ev1" }) });

function agendaEvent(settings: Record<string, unknown>) {
  return {
    id: "ev1",
    name: "Conference",
    slug: "CONF2027",
    startDate: new Date("2027-01-15T04:00:00Z"),
    endDate: new Date("2027-01-17T14:00:00Z"),
    timezone: "Asia/Dubai",
    supportEmail: null,
    bannerImage: null,
    bannerImageMobile: null,
    settings,
    organization: { name: "Org", logo: null },
    tracks: [],
    eventSessions: [],
  };
}

function expectPrivate(res: Response) {
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
}

describe("GET /api/events/[eventId]/agenda-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockRequirePermission.mockReturnValue({ ok: true, principal: {}, eventWhere: { id: "ev1" } });
    mockFindGatedEvent.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  });

  it("asks for the programme key on this event, hiding rather than refusing", async () => {
    mockLoadAgendaEvent.mockResolvedValue(agendaEvent({}));
    await call();
    expect(mockRequirePermission).toHaveBeenCalledWith(
      expect.anything(),
      "sessions.read",
      expect.objectContaining({ eventId: "ev1", onMissing: "hide" }),
    );
    // No linkedRoles: reviewers, submitters and registrants are not let in.
    expect(mockRequirePermission.mock.calls[0][2]).not.toHaveProperty("linkedRoles");
  });

  it("serves an unpublished agenda, uncached and unindexed, saying it is unpublished", async () => {
    mockLoadAgendaEvent.mockResolvedValue(agendaEvent({ agendaPublished: false, agendaTrackBorder: false }));
    const res = await call();
    expect(res.status).toBe(200);
    expectPrivate(res);
    const body = await res.json();
    expect(body).toMatchObject({ slug: "CONF2027", preview: true, published: false, trackBorder: false });
    expect(body).not.toHaveProperty("settings");
  });

  it("says when the agenda is already published (the old programmePublished name too)", async () => {
    mockLoadAgendaEvent.mockResolvedValue(agendaEvent({ programmePublished: true }));
    const res = await call();
    expect((await res.json()).published).toBe(true);
  });

  it("answers 401, uncached, to a signed-out visitor", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expectPrivate(res);
    expect((await res.json()).code).toBe("SIGN_IN_REQUIRED");
    expect(mockLoadAgendaEvent).not.toHaveBeenCalled();
  });

  it("answers 404, uncached, when the gate finds no event", async () => {
    mockFindGatedEvent.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expectPrivate(res);
    expect(mockLoadAgendaEvent).not.toHaveBeenCalled();
  });
});
