/**
 * GET /api/events/[eventId]/export-bundle: the real guards decide who may take
 * a whole event away; the bundle builder is mocked (it has its own tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
const { loggerMock } = vi.hoisted(() => ({ loggerMock: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ apiLogger: loggerMock, dbLogger: loggerMock, authLogger: loggerMock, eventLogger: loggerMock }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
const rate = vi.hoisted(() => ({ allowed: true, retryAfterSeconds: 0 }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => rate, getClientIp: () => "1.2.3.4" }));
const mockDb = vi.hoisted(() => ({ event: { findFirst: vi.fn() }, user: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
const audit = vi.hoisted(() => ({ recordExport: vi.fn() }));
vi.mock("@/lib/audit-data-transfer", () => audit);
const bundle = vi.hoisted(() => ({ buildEventBundle: vi.fn() }));
vi.mock("@/lib/event-export/bundle", () => bundle);

import { GET } from "@/app/api/events/[eventId]/export-bundle/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const req = () => new Request("https://x/api/events/ev1/export-bundle");
const session = (role: string) => ({ user: { id: "u1", organizationId: "org1", role, firstName: "Lina", lastName: "Saad" } });

beforeEach(() => {
  vi.clearAllMocks();
  rate.allowed = true;
  authMock.mockResolvedValue(session("ORGANIZER"));
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", slug: "cardio", organizationId: "org1" });
  bundle.buildEventBundle.mockResolvedValue({
    zip: Buffer.from("PK"),
    filename: "cardio-data-2026-09-30.zip",
    totalRows: 12,
    parts: [{ file: "registrations.csv", label: "Registrations", rows: 12, skipped: null }, { file: "invoices.csv", label: "Invoices", rows: null, skipped: "x" }],
  });
});

describe("who may export a whole event", () => {
  it.each(["MEMBER", "ONSITE", "WEBINARS", "REVIEWER", "SUBMITTER", "REGISTRANT", "CRM_USER", "HR_USER"])("%s is refused before any read", async (role) => {
    authMock.mockResolvedValue(session(role));
    expect((await GET(req(), params)).status).toBe(403);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    expect(bundle.buildEventBundle).not.toHaveBeenCalled();
  });

  it("signed out is 401; an event outside access is 404", async () => {
    authMock.mockResolvedValue(null);
    expect((await GET(req(), params)).status).toBe(401);
    authMock.mockResolvedValue(session("ADMIN"));
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await GET(req(), params)).status).toBe(404);
  });
});

describe("the download", () => {
  it("returns the ZIP, no-store, and records one bundle audit row", async () => {
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="cardio-data-2026-09-30.zip"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(bundle.buildEventBundle).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1", principal: expect.objectContaining({ baseRole: "ORGANIZER" }), userName: "Lina Saad" }));
    expect(audit.recordExport).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ entityType: "EventDataBundle", eventId: "ev1", rowCount: 12, format: "zip", filters: { files: 1, skipped: "Invoices" } }));
  });

  it("is rate limited per person and event", async () => {
    rate.allowed = false;
    rate.retryAfterSeconds = 900;
    const res = await GET(req(), params);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("900");
    expect(bundle.buildEventBundle).not.toHaveBeenCalled();
  });

  it("a builder crash is a logged 500", async () => {
    bundle.buildEventBundle.mockRejectedValue(new Error("boom"));
    expect((await GET(req(), params)).status).toBe(500);
    expect(loggerMock.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "event-export:failed" }));
  });
});
