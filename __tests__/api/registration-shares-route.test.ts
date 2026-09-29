/**
 * Shared registration views, the organiser routes: the REAL guards decide who
 * may manage views; the service is mocked (it has its own tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
const { loggerMock } = vi.hoisted(() => ({ loggerMock: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ apiLogger: loggerMock, dbLogger: loggerMock, authLogger: loggerMock, eventLogger: loggerMock }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
const mockDb = vi.hoisted(() => ({ event: { findFirst: vi.fn() }, user: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
const svc = vi.hoisted(() => ({
  listRegistrationViews: vi.fn(),
  createRegistrationView: vi.fn(),
  updateRegistrationView: vi.fn(),
  regenerateRegistrationView: vi.fn(),
  deleteRegistrationView: vi.fn(),
}));
vi.mock("@/services/registration-share-service", () => svc);

import { GET, POST } from "@/app/api/events/[eventId]/registration-shares/route";
import { PUT, DELETE } from "@/app/api/events/[eventId]/registration-shares/[viewId]/route";
import { POST as REGEN } from "@/app/api/events/[eventId]/registration-shares/[viewId]/regenerate/route";

const p1 = { params: Promise.resolve({ eventId: "ev1" }) };
const p2 = { params: Promise.resolve({ eventId: "ev1", viewId: "v1" }) };
const session = (role: string) => ({ user: { id: "u1", organizationId: "org1", role } });
const req = (body: unknown) => ({ json: async () => body }) as unknown as Request;
const body = {
  label: "Front desk",
  enabled: true,
  expiresAt: null,
  statuses: ["CONFIRMED"],
  fields: [],
  ticketTypeIds: [],
  sponsorIds: [],
  promoCodeIds: [],
  includeFaculty: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(session("ORGANIZER"));
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", slug: "cardio", organizationId: "org1" });
  svc.listRegistrationViews.mockResolvedValue({ views: [], options: { ticketTypes: [], sponsors: [], promoCodes: [] } });
  for (const k of ["createRegistrationView", "updateRegistrationView", "regenerateRegistrationView", "deleteRegistrationView"] as const) {
    svc[k].mockResolvedValue({ ok: true, id: "v1" });
  }
});

const calls = () => [
  GET(req(null), p1),
  POST(req(body), p1),
  PUT(req(body), p2),
  DELETE(req(null), p2),
  REGEN(req(null), p2),
];

describe("who manages shared views", () => {
  it.each(["MEMBER", "ONSITE", "WEBINARS", "REVIEWER", "SUBMITTER", "REGISTRANT", "CRM_USER", "HR_USER"])("%s is refused on all five handlers", async (role) => {
    authMock.mockResolvedValue(session(role));
    for (const res of await Promise.all(calls())) expect(res.status).toBe(403);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("signed out is 401 everywhere; an event outside access is 404", async () => {
    authMock.mockResolvedValue(null);
    for (const res of await Promise.all(calls())) expect(res.status).toBe(401);
    authMock.mockResolvedValue(session("ADMIN"));
    mockDb.event.findFirst.mockResolvedValue(null);
    for (const res of await Promise.all(calls())) expect(res.status).toBe(404);
    expect(mockDb.event.findFirst.mock.calls[0][0].where).toMatchObject({ organizationId: "org1" });
  });
});

describe("mapping", () => {
  it("create answers 201 with the list; the service receives a Date expiry", async () => {
    const res = await POST(req({ ...body, expiresAt: "2030-01-01T00:00:00.000Z" }), p1);
    expect(res.status).toBe(201);
    expect(svc.createRegistrationView.mock.calls[0][1].expiresAt).toEqual(new Date("2030-01-01T00:00:00.000Z"));
    expect(svc.createRegistrationView.mock.calls[0][0]).toEqual({ eventId: "ev1", slug: "cardio", organizationId: "org1", userId: "u1" });
  });

  it("a malformed body is 400 before the service", async () => {
    for (const bad of [null, { ...body, fields: "email" }, { ...body, expiresAt: "tomorrow" }, { ...body, includeFaculty: undefined }]) {
      expect((await POST(req(bad), p1)).status).toBe(400);
      expect((await PUT(req(bad), p2)).status).toBe(400);
    }
    expect(svc.createRegistrationView).not.toHaveBeenCalled();
    expect(svc.updateRegistrationView).not.toHaveBeenCalled();
  });

  it("service refusals map to 400 / 404 / 409", async () => {
    svc.createRegistrationView.mockResolvedValueOnce({ ok: false, code: "UNKNOWN_FILTER", message: "x" });
    expect((await POST(req(body), p1)).status).toBe(400);
    svc.createRegistrationView.mockResolvedValueOnce({ ok: false, code: "LABEL_TAKEN", message: "x" });
    expect((await POST(req(body), p1)).status).toBe(409);
    svc.deleteRegistrationView.mockResolvedValueOnce({ ok: false, code: "NOT_FOUND", message: "x" });
    expect((await DELETE(req(null), p2)).status).toBe(404);
  });
});
