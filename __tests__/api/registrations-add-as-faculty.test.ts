/**
 * Add Registration, "Faculty" (Nov 10, 2026; owner: Faculty is the umbrella
 * for invited speakers and committee). The route resolves the event's Faculty
 * type itself, makes the registration comp, and turns the committee role into
 * the `committee` tags and the badge. It never accepts a type the browser
 * picked alongside it, and the committee role only comes with Faculty.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockCreate, mockEnsureFaculty } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() } },
  mockAuth: vi.fn(),
  mockCreate: vi.fn(),
  mockEnsureFaculty: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockReturnValue({ catch: () => {} }) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/services/registration-service", () => ({ createRegistration: mockCreate }));
vi.mock("@/lib/speaker-companion", () => ({ ensureFacultyTicketType: mockEnsureFaculty }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));

import { POST } from "@/app/api/events/[eventId]/registrations/route";

const ATTENDEE = { email: "dr.sara@example.com", firstName: "Sara", lastName: "Haddad", tags: ["vip"] };
const post = (body: Record<string, unknown>) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify({ attendee: ATTENDEE, ...body }) }), {
    params: Promise.resolve({ eventId: "ev1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", organizationId: "org1", firstName: "Ada" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockEnsureFaculty.mockResolvedValue("tt-faculty");
  mockCreate.mockResolvedValue({ ok: true, registration: { id: "reg1" } });
});

describe("POST registrations, added as Faculty", () => {
  it("resolves the event's Faculty type, comp, and the committee role becomes tags and badge", async () => {
    const res = await post({ asFaculty: true, committeeRole: "SCIENTIFIC" });
    expect(res.status).toBe(201);
    expect(mockEnsureFaculty).toHaveBeenCalledWith("ev1");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketTypeId: "tt-faculty",
        asFaculty: true,
        badgeType: "Scientific Committee",
        paymentStatus: "COMPLIMENTARY",
        // Title Case, as the dashboard writes every tag ("vip" arrives as "Vip").
        attendee: expect.objectContaining({ tags: ["Vip", "Committee", "Scientific Committee"] }),
      }),
    );
  });

  it("without a committee role it is plain Faculty: badge Faculty, no committee tags", async () => {
    await post({ asFaculty: true });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ badgeType: "Faculty", attendee: expect.objectContaining({ tags: ["Vip"] }) }),
    );
  });

  it("400 when a type is picked alongside it: the route chooses the Faculty type, never the browser", async () => {
    const res = await post({ asFaculty: true, ticketTypeId: "tt-standard" });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("400 for a committee role without Faculty (a delegate's committee stays a tag set by hand)", async () => {
    const res = await post({ committeeRole: "ORGANIZING", ticketTypeId: "tt-standard" });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("403 for a desk role: adding Faculty is an organiser's call (the speakers.create key)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org1", firstName: "Mo" } });
    const res = await post({ asFaculty: true });
    expect(res.status).toBe(403);
    expect(mockEnsureFaculty).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("an ordinary add is untouched: no Faculty type resolved, nothing forced", async () => {
    await post({ ticketTypeId: "tt-standard", paymentStatus: "UNPAID" });
    expect(mockEnsureFaculty).not.toHaveBeenCalled();
    const input = mockCreate.mock.calls[0][0];
    expect(input).toMatchObject({ ticketTypeId: "tt-standard", paymentStatus: "UNPAID" });
    expect(input).not.toHaveProperty("asFaculty");
  });
});

describe("withCommitteeTags", () => {
  it("never adds a committee tag the person already has, whatever its case", async () => {
    const { withCommitteeTags } = await import("@/lib/faculty-registration");
    expect(withCommitteeTags(["committee", "Vip"], "ORGANIZING")).toEqual(["committee", "Vip", "Organizing Committee"]);
    expect(withCommitteeTags(undefined, "NONE")).toEqual([]);
  });
});
