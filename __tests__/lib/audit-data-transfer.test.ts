/**
 * Unit tests for the shared import/export audit helper.
 *
 * These pin the two properties that make the helper safe to call from a
 * completed export: it records the right shape, and it can NEVER throw or
 * reject into the caller (an audit-write blip must not fail a file the user
 * already received — but it must be visible in the error log).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger, mockGetClientIp } = vi.hoisted(() => ({
  mockDb: { auditLog: { create: vi.fn() } },
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  mockGetClientIp: vi.fn(() => "203.0.113.9"),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/security", () => ({ getClientIp: mockGetClientIp }));

import { recordExport, recordImport } from "@/lib/audit-data-transfer";

/** A resolved create() — the happy path. */
function resolves() {
  mockDb.auditLog.create.mockReturnValue(Promise.resolve({ id: "a1" }));
}
/** A rejected create() — the DB-blip path. */
function rejects(err = new Error("pool timeout")) {
  mockDb.auditLog.create.mockReturnValue(Promise.reject(err));
}

const req = new Request("https://events.example.com/api/x");

beforeEach(() => {
  vi.clearAllMocks();
  mockGetClientIp.mockReturnValue("203.0.113.9");
  resolves();
});

describe("recordExport", () => {
  it("writes an EXPORT row carrying who / how many / from where", () => {
    recordExport(req, {
      entityType: "Registration",
      eventId: "evt_1",
      organizationId: "org_1",
      userId: "usr_1",
      role: "ORGANIZER",
      rowCount: 412,
      format: "csv",
    });

    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const data = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(data.action).toBe("EXPORT");
    expect(data.entityType).toBe("Registration");
    expect(data.eventId).toBe("evt_1");
    expect(data.userId).toBe("usr_1");
    expect(data.changes).toMatchObject({
      rowCount: 412,
      role: "ORGANIZER",
      organizationId: "org_1",
      format: "csv",
      source: "rest",
      ip: "203.0.113.9",
    });
  });

  it("scopes entityId to the event when event-scoped", () => {
    recordExport(req, { entityType: "Registration", eventId: "evt_9", organizationId: "org_1", rowCount: 1 });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.entityId).toBe("event:evt_9");
  });

  it("falls back to the org when there is no event (contacts / invoices / CRM)", () => {
    recordExport(req, { entityType: "Contact", organizationId: "org_7", rowCount: 5 });
    const data = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(data.entityId).toBe("org:org_7");
    expect(data.eventId).toBeNull();
  });

  it("omits the filters key entirely when nothing narrowed the export", () => {
    recordExport(req, { entityType: "Contact", organizationId: "org_1", rowCount: 5, filters: {} });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).not.toHaveProperty("filters");
  });

  it("records the filters that narrowed the export", () => {
    recordExport(req, {
      entityType: "Registration",
      eventId: "evt_1",
      organizationId: "org_1",
      rowCount: 12,
      filters: { status: "CONFIRMED", tags: ["vip"], q: "smith" },
    });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.filters).toEqual({
      status: "CONFIRMED",
      tags: ["vip"],
      q: "smith",
    });
  });

  it("defaults source to rest and format to csv", () => {
    recordExport(req, { entityType: "Contact", organizationId: "org_1", rowCount: 0 });
    const changes = mockDb.auditLog.create.mock.calls[0][0].data.changes;
    expect(changes.source).toBe("rest");
    expect(changes.format).toBe("csv");
  });

  it("records a null ip when there is no request to read one from", () => {
    recordExport(null, { entityType: "Contact", organizationId: "org_1", rowCount: 1 });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.ip).toBeNull();
    expect(mockGetClientIp).not.toHaveBeenCalled();
  });

  // The contract that lets callers fire this after streaming a file.
  it("never throws, and logs at error, when the audit write fails", async () => {
    rejects();
    expect(() =>
      recordExport(req, { entityType: "Contact", organizationId: "org_1", rowCount: 3 }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "audit-export:write-failed", entityType: "Contact" }),
    );
  });
});

describe("recordImport — awaitable", () => {
  // This exists because of a production incident. The contacts import script
  // called recordImport fire-and-forget, then disconnected Prisma and exited.
  // The write raced the teardown and failed; that failure logged at error
  // level; the logger's admin-alert path then read `alertState` on the
  // disconnected client; that read failed and logged at error level; and the
  // two fed each other in an unbounded loop that filled the log file until it
  // could no longer be read into memory.
  //
  // Long-lived HTTP callers must still ignore the return value. A short-lived
  // script must be able to await it.
  it("returns a promise, so a script can await it before disconnecting", async () => {
    mockDb.auditLog.create.mockReturnValueOnce(Promise.resolve({ id: "a1" }));
    const returned = recordImport(req, {
      entityType: "Contact",
      organizationId: "org_1",
      totalProcessed: 1,
    });
    expect(typeof returned?.then).toBe("function");
    await expect(returned).resolves.toBeUndefined();
  });

  it("never rejects, so awaiting it cannot fail the caller", async () => {
    // The whole point of fire-and-forget is that an audit blip is not fatal.
    // Making it awaitable must not quietly turn it into a throw.
    mockDb.auditLog.create.mockReturnValueOnce(Promise.reject(new Error("db down")));
    await expect(
      recordImport(req, { entityType: "Contact", organizationId: "org_1", totalProcessed: 1 }),
    ).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

describe("recordImport", () => {
  it("writes an IMPORT row with the created/skipped/errors breakdown", () => {
    recordImport(req, {
      entityType: "Registration",
      eventId: "evt_2",
      organizationId: "org_1",
      userId: "usr_2",
      role: "ADMIN",
      totalProcessed: 100,
      created: 90,
      skipped: 7,
      errors: 3,
      format: "csv",
    });

    const data = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(data.action).toBe("IMPORT");
    expect(data.entityId).toBe("event:evt_2");
    expect(data.changes).toMatchObject({
      totalProcessed: 100,
      created: 90,
      skipped: 7,
      errors: 3,
      format: "csv",
    });
  });

  // Skipped/failed rows leave no per-row CREATE audit, so 0 must be recorded
  // as 0 rather than dropped — "90 of 100 landed" is the fact being preserved.
  it("keeps zero counts instead of omitting them", () => {
    recordImport(req, {
      entityType: "Abstract",
      eventId: "evt_3",
      organizationId: "org_1",
      totalProcessed: 5,
      created: 5,
      skipped: 0,
      errors: 0,
    });
    const changes = mockDb.auditLog.create.mock.calls[0][0].data.changes;
    expect(changes.skipped).toBe(0);
    expect(changes.errors).toBe(0);
  });

  it("omits counts the caller did not supply", () => {
    recordImport(req, {
      entityType: "Registration",
      eventId: "evt_4",
      organizationId: "org_1",
      totalProcessed: 3,
      created: 3,
    });
    const changes = mockDb.auditLog.create.mock.calls[0][0].data.changes;
    expect(changes).not.toHaveProperty("skipped");
    expect(changes).not.toHaveProperty("errors");
    expect(changes).not.toHaveProperty("updated");
  });

  it("never throws, and logs at error, when the audit write fails", async () => {
    rejects();
    expect(() =>
      recordImport(req, { entityType: "Contact", organizationId: "org_1", totalProcessed: 1 }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "audit-import:write-failed" }),
    );
  });
});
