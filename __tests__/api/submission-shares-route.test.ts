/**
 * Shared submission views, organiser side (Sep 29, 2026): the REAL guards
 * (denyReviewer, requireOrgId, buildEventAccessWhere) decide who manages a
 * link; the database is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
const { loggerMock } = vi.hoisted(() => ({ loggerMock: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ apiLogger: loggerMock, dbLogger: loggerMock, authLogger: loggerMock, eventLogger: loggerMock }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));

const mockDb = vi.hoisted(() => ({
  event: { findFirst: vi.fn() },
  submissionShareLink: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  user: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { GET, PUT, POST } from "@/app/api/events/[eventId]/submission-shares/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const session = (role: string) => ({ user: { id: "u1", organizationId: "org1", role } });
const req = (body: unknown) => ({ json: async () => body }) as unknown as Request;
const EVENT = { id: "ev1", slug: "cardio-2027", organizationId: "org1" };

const stored = (over: Record<string, unknown> = {}) => ({
  id: "l1",
  eventId: "ev1",
  organizationId: "org1",
  kind: "ABSTRACTS",
  token: "tok-old-000000000000000000000000",
  enabled: true,
  statuses: ["ACCEPTED"],
  fields: ["content"],
  createdById: "u1",
  updatedById: "u1",
  createdAt: new Date(),
  updatedAt: new Date("2026-09-29T08:00:00Z"),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(session("ORGANIZER"));
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.submissionShareLink.findMany.mockResolvedValue([]);
  mockDb.submissionShareLink.findUnique.mockResolvedValue(null);
  mockDb.submissionShareLink.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => stored(data));
  mockDb.submissionShareLink.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => stored(data));
  mockDb.user.findMany.mockResolvedValue([{ id: "u1", firstName: "Lina", lastName: "Saad" }]);
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("who manages a shared link", () => {
  it.each(["MEMBER", "ONSITE", "WEBINARS", "REVIEWER", "SUBMITTER", "REGISTRANT", "CRM_USER", "HR_USER"])(
    "%s is refused on every verb before any database read",
    async (role) => {
      authMock.mockResolvedValue(session(role));
      expect((await GET(req(null), params)).status).toBe(403);
      expect((await PUT(req({ kind: "ABSTRACTS", enabled: true, statuses: ["ACCEPTED"], fields: [] }), params)).status).toBe(403);
      expect((await POST(req({ kind: "ABSTRACTS", action: "regenerate" }), params)).status).toBe(403);
      expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    },
  );

  it("signed out is 401; an event outside the caller's access is 404", async () => {
    authMock.mockResolvedValue(null);
    expect((await GET(req(null), params)).status).toBe(401);
    authMock.mockResolvedValue(session("ADMIN"));
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await GET(req(null), params)).status).toBe(404);
    // The lookup is org-scoped by the real access builder.
    expect(mockDb.event.findFirst.mock.calls[0][0].where).toMatchObject({ organizationId: "org1" });
  });
});

describe("GET", () => {
  it("returns both kinds, with defaults and no path until a link exists", async () => {
    mockDb.submissionShareLink.findMany.mockResolvedValue([stored()]);
    const body = await (await GET(req(null), params)).json();
    expect(body.links).toHaveLength(2);
    const [abs, prop] = body.links;
    expect(abs).toMatchObject({ kind: "ABSTRACTS", exists: true, path: "/e/cardio-2027/shared/tok-old-000000000000000000000000", updatedByName: "Lina Saad" });
    expect(prop).toMatchObject({ kind: "SESSION_PROPOSALS", exists: false, path: null, statuses: ["SUBMITTED"] });
  });
});

describe("PUT", () => {
  it("creates the link on first save with a fresh long token, stamped with the event's org, and audits it", async () => {
    const res = await PUT(req({ kind: "ABSTRACTS", enabled: true, statuses: ["ACCEPTED"], fields: ["content", "theme"] }), params);
    expect(res.status).toBe(200);
    const data = mockDb.submissionShareLink.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ eventId: "ev1", organizationId: "org1", kind: "ABSTRACTS", statuses: ["ACCEPTED"], fields: ["content", "theme"] });
    expect(data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "SUBMISSION_SHARE_CREATED", entityType: "SubmissionShareLink" });
    expect(loggerMock.warn).not.toHaveBeenCalledWith(expect.objectContaining({ msg: "submission-shares:contact-fields-enabled" }));
  });

  it("updates in place, keeping the token, and logs a warning when a contact field is newly switched on", async () => {
    mockDb.submissionShareLink.findUnique.mockResolvedValue(stored());
    await PUT(req({ kind: "ABSTRACTS", enabled: true, statuses: ["ACCEPTED"], fields: ["content", "authorEmail"] }), params);
    const upd = mockDb.submissionShareLink.update.mock.calls[0][0];
    expect(upd.data).not.toHaveProperty("token");
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "submission-shares:contact-fields-enabled", fields: ["authorEmail"] }));
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ contactFieldsShown: ["authorEmail"], before: { fields: ["content"] } });
  });

  it("refuses a hidden status, an unknown field, no status, and a malformed body, writing nothing", async () => {
    for (const body of [
      { kind: "ABSTRACTS", enabled: true, statuses: ["DRAFT"], fields: [] },
      { kind: "ABSTRACTS", enabled: true, statuses: ["ACCEPTED"], fields: ["reviewScore"] },
      { kind: "ABSTRACTS", enabled: true, statuses: [], fields: [] },
      { kind: "ORDERS", enabled: true, statuses: [], fields: [] },
      null,
    ]) {
      expect((await PUT(req(body), params)).status).toBe(400);
    }
    expect(mockDb.submissionShareLink.create).not.toHaveBeenCalled();
    expect(mockDb.submissionShareLink.update).not.toHaveBeenCalled();
  });
});

describe("POST regenerate", () => {
  it("replaces the token and audits it", async () => {
    mockDb.submissionShareLink.findUnique.mockResolvedValue(stored());
    const res = await POST(req({ kind: "ABSTRACTS", action: "regenerate" }), params);
    expect(res.status).toBe(200);
    const token = mockDb.submissionShareLink.update.mock.calls[0][0].data.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe("tok-old-000000000000000000000000");
    expect(mockDb.auditLog.create.mock.calls[0][0].data.action).toBe("SUBMISSION_SHARE_REGENERATED");
  });

  it("404s when there is no link yet", async () => {
    expect((await POST(req({ kind: "SESSION_PROPOSALS", action: "regenerate" }), params)).status).toBe(404);
    expect(mockDb.submissionShareLink.update).not.toHaveBeenCalled();
  });
});
