/**
 * The registrant portal's self-edit writes the Attendee only. Staff edits use
 * the REGISTRATION's updatedAt as their "changed since you opened it" token,
 * so the self-edit also touches the registration(s) on that attendee, in the
 * same transaction; otherwise staff silently overwrote the attendee's own
 * change (Oct 29, 2026).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, tx } = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    registration: { updateMany: vi.fn() },
    attendee: { update: vi.fn() },
  };
  return {
    tx,
    mockAuth: vi.fn(),
    mockDb: {
      registration: { findFirst: vi.fn() },
      event: { findFirst: vi.fn() },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    },
  };
});

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (t: unknown) => unknown) => mockDb.$transaction(fn) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveRequestOrgId: vi.fn(async () => null) }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_o: unknown, _c: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));

import { PUT } from "@/app/api/registrant/registrations/route";
import { apiLogger } from "@/lib/logger";

const put = (body: unknown) =>
  PUT(new Request("http://x/api/registrant/registrations", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", email: "a@b.com", role: "REGISTRANT" } });
  mockDb.registration.findFirst.mockResolvedValue({ id: "reg1", attendeeId: "att1", eventId: "ev1" });
  mockDb.event.findFirst.mockResolvedValue({ organizationId: "org1" });
  tx.registration.updateMany.mockResolvedValue({ count: 1 });
  tx.attendee.update.mockResolvedValue({ id: "att1", email: "a@b.com", firstName: "New", lastName: "Name" });
});

describe("registrant self-edit", () => {
  it("touches every registration on the attendee, in the same transaction as the attendee write", async () => {
    const res = await put({ registrationId: "reg1", attendee: { firstName: "New" } });
    expect(res.status).toBe(200);
    // No row is sent back (the page refetches its list through the route's
    // allow-list): one read, the ownership check.
    expect(await res.json()).toEqual({ success: true });
    expect(mockDb.registration.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    // The rows are locked, in id order, before they are touched.
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.registration.updateMany.mock.invocationCallOrder[0]);
    expect(tx.registration.updateMany).toHaveBeenCalledWith({ where: { attendeeId: "att1" }, data: { updatedAt: expect.any(Date) } });
    expect(tx.attendee.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "att1" }, data: expect.objectContaining({ firstName: "New" }) }));
  });

  it("a speaker's Faculty registration keeps its name (it follows the speaker record); the other fields save", async () => {
    const faculty = { id: "reg1", attendeeId: "att1", eventId: "ev1", createdSource: "SPEAKER_COMPANION", attendee: { firstName: "Sam", lastName: "Speaker" } };
    mockDb.registration.findFirst.mockResolvedValue(faculty);
    const res = await put({ registrationId: "reg1", attendee: { firstName: "Renamed", lastName: "Person", phone: "+971500000000" } });
    expect(res.status).toBe(200);
    const written = tx.attendee.update.mock.calls[0][0].data;
    expect(written).toMatchObject({ phone: "+971500000000" });
    expect(written).not.toHaveProperty("firstName");
    expect(written).not.toHaveProperty("lastName");
    expect(apiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registrant-self-edit:faculty-name-not-changed" }));

    // The page sends the current name with every save: that is not a refusal, so no warning.
    vi.mocked(apiLogger.warn).mockClear();
    await put({ registrationId: "reg1", attendee: { firstName: "Sam", lastName: "Speaker", phone: "+971511111111" } });
    expect(apiLogger.warn).not.toHaveBeenCalled();
  });

  it("someone else's registration is a 404 and nothing is written", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await put({ registrationId: "reg9", attendee: { firstName: "New" } });
    expect(res.status).toBe(404);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

describe("registrant self-edit rate limit", () => {
  // Last in the file on purpose: it spends this user's hourly allowance.
  it("the 31st save in an hour is a logged 429 that says when to come back, and writes nothing", async () => {
    let last = await put({ registrationId: "reg1", attendee: { phone: "1" } });
    for (let i = 0; i < 40 && last.status !== 429; i++) last = await put({ registrationId: "reg1", attendee: { phone: String(i) } });
    expect(last.status).toBe(429);
    expect(await last.json()).toMatchObject({ limit: 30, windowSeconds: 3600, retryAfterSeconds: expect.any(Number) });
    expect(apiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registrant-self-edit:rate-limited" }));
    const writes = tx.attendee.update.mock.calls.length;
    await put({ registrationId: "reg1", attendee: { phone: "again" } });
    expect(tx.attendee.update.mock.calls.length).toBe(writes);
  });
});
