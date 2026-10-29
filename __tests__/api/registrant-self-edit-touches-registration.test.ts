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
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    // The rows are locked, in id order, before they are touched.
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.registration.updateMany.mock.invocationCallOrder[0]);
    expect(tx.registration.updateMany).toHaveBeenCalledWith({ where: { attendeeId: "att1" }, data: { updatedAt: expect.any(Date) } });
    expect(tx.attendee.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "att1" }, data: expect.objectContaining({ firstName: "New" }) }));
  });

  it("someone else's registration is a 404 and nothing is written", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await put({ registrationId: "reg9", attendee: { firstName: "New" } });
    expect(res.status).toBe(404);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});
