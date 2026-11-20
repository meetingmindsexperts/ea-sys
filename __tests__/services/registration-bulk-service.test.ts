/**
 * The general actions on ticked registrations (owner, Nov 20, 2026; plan
 * docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md step 3). It adds no rule about
 * what a change does: each row goes through the single registration's own
 * update or cancel. Its one caution: money never disappears in bulk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { findMany, updateSpy, cancelSpy, refreshStats, logger } = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateSpy: vi.fn(),
  cancelSpy: vi.fn(),
  refreshStats: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: { registration: { findMany } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: refreshStats }));
vi.mock("@/services/registration-service", () => ({ updateRegistration: updateSpy }));
vi.mock("@/services/payment-service", () => ({ cancelRegistration: cancelSpy }));

import { bulkUpdateRegistrations, MAX_BULK_REGISTRATION_UPDATES } from "@/services/registration-bulk-service";

const UPDATED = new Date("2026-11-20T08:00:00.000Z");
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: "CONFIRMED", paymentStatus: "UNASSIGNED", badgeType: null, groupId: null, refundedAmount: 0, updatedAt: UPDATED,
  _count: { payments: 0, invoices: 0 }, ...over,
});
let rows: ReturnType<typeof row>[];

const input = (over: Record<string, unknown> = {}) => ({
  eventId: "ev1", organizationId: "org1", actorUserId: "u1", source: "rest" as const,
  registrationIds: rows.map((r) => r.id),
  ...over,
});
const updates = () => updateSpy.mock.calls.map(([a]) => a);
const skipsOf = (result: Awaited<ReturnType<typeof bulkUpdateRegistrations>>) =>
  result.ok ? result.skipped.map((s) => [s.registrationId, s.part, s.code]) : [];

beforeEach(() => {
  vi.clearAllMocks();
  rows = [row("owing"), row("free", { paymentStatus: "COMPLIMENTARY" })];
  findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => rows.filter((r) => where.id.in.includes(r.id)));
  updateSpy.mockResolvedValue({ ok: true });
  cancelSpy.mockResolvedValue({ ok: true, cancel: { status: "CANCELLED", refunded: false } });
});

describe("make presenters: Complimentary and a badge, through the single registration's update", () => {
  it("sets both on a row that owes, only the badge on one already free, and reads the event's rows only", async () => {
    const result = await bulkUpdateRegistrations(input({ paymentStatus: "COMPLIMENTARY", badgeType: "Presenter" }));
    expect(result).toMatchObject({ ok: true, changed: ["owing", "free"], unchanged: [], skipped: [], remaining: [] });
    expect(findMany.mock.calls[0][0].where).toEqual({ id: { in: ["owing", "free"] }, eventId: "ev1" });
    expect(updates()[0]).toMatchObject({ eventId: "ev1", registrationId: "owing", actorUserId: "u1", paymentStatus: "COMPLIMENTARY", badgeType: "Presenter" });
    expect(updates()[1]).toMatchObject({ registrationId: "free", badgeType: "Presenter" });
    expect(updates()[1]).not.toHaveProperty("paymentStatus");
    expect(refreshStats).toHaveBeenCalledTimes(1);
  });

  it("a row that already is what was asked is left alone, with no write", async () => {
    rows = [row("done", { paymentStatus: "COMPLIMENTARY", badgeType: "Presenter" })];
    const result = await bulkUpdateRegistrations(input({ paymentStatus: "COMPLIMENTARY", badgeType: "Presenter" }));
    expect(result).toMatchObject({ ok: true, changed: [], unchanged: ["done"] });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(refreshStats).not.toHaveBeenCalled();
  });

  it("an empty badge type clears it", async () => {
    rows = [row("badged", { badgeType: "Presenter" })];
    await bulkUpdateRegistrations(input({ badgeType: "" }));
    expect(updates()[0].badgeType).toBeNull();
  });

  it("someone who edited the registration since it was read wins: the write names what was read", async () => {
    await bulkUpdateRegistrations(input({ badgeType: "Presenter" }));
    expect(updates()[0].expectedUpdatedAt).toBe(UPDATED.toISOString());
  });
});

describe("money never disappears in bulk", () => {
  it.each([
    ["paid", { paymentStatus: "PAID" }, "HAS_MONEY"],
    ["a payment recorded", { _count: { payments: 1, invoices: 0 } }, "HAS_MONEY"],
    ["an invoice issued", { _count: { payments: 0, invoices: 1 } }, "HAS_MONEY"],
    ["partly refunded", { refundedAmount: 50 }, "HAS_MONEY"],
    ["payment in progress", { paymentStatus: "PENDING" }, "HAS_MONEY"],
    ["sponsor-paid", { paymentStatus: "INCLUSIVE" }, "SPONSOR_PAID"],
    ["a group member", { groupId: "g1" }, "GROUP_MEMBER"],
  ])("%s: the payment status is not changed, and the row is named; the badge is still set", async (_name, over, code) => {
    rows = [row("r1", over)];
    const result = await bulkUpdateRegistrations(input({ paymentStatus: "COMPLIMENTARY", badgeType: "Presenter" }));
    expect(skipsOf(result)).toEqual([["r1", "paymentStatus", code]]);
    expect(result).toMatchObject({ ok: true, changed: ["r1"] });
    expect(updates()[0]).toMatchObject({ badgeType: "Presenter" });
    expect(updates()[0]).not.toHaveProperty("paymentStatus");
  });

  it("with only a payment status asked, such a row gets no write at all", async () => {
    rows = [row("paid", { paymentStatus: "PAID" })];
    const result = await bulkUpdateRegistrations(input({ paymentStatus: "COMPLIMENTARY" }));
    expect(result).toMatchObject({ ok: true, changed: [], unchanged: [] });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registration-bulk-update:some-skipped" }));
  });

  it("a row with money on it is never cancelled here: the refund is decided on its own page", async () => {
    rows = [row("paid", { paymentStatus: "PAID" }), row("owing")];
    const result = await bulkUpdateRegistrations(input({ cancel: true }));
    expect(skipsOf(result)).toEqual([["paid", "cancel", "HAS_MONEY"]]);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy.mock.calls[0][0]).toMatchObject({ registrationId: "owing", eventId: "ev1", refund: false, issuedByUserId: "u1" });
  });
});

describe("cancel", () => {
  it("is the Cancel button's own path, never a status write; an already cancelled row is as asked", async () => {
    rows = [row("owing"), row("gone", { status: "CANCELLED" })];
    const result = await bulkUpdateRegistrations(input({ cancel: true }));
    expect(result).toMatchObject({ ok: true, changed: ["owing"], unchanged: ["gone"], skipped: [] });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("what the single cancel refuses is skipped with its own words", async () => {
    cancelSpy.mockResolvedValue({ ok: false, code: "UNKNOWN", message: "Could not cancel" });
    const result = await bulkUpdateRegistrations(input({ cancel: true, registrationIds: ["owing"] }));
    expect(result.ok && result.skipped).toEqual([{ registrationId: "owing", part: "cancel", code: "REFUSED", message: "Could not cancel" }]);
  });
});

describe("what one row refuses does not stop the rest", () => {
  it("a cancelled row gets nothing set; an id from elsewhere is not found", async () => {
    rows = [row("gone", { status: "CANCELLED" }), row("owing")];
    const result = await bulkUpdateRegistrations(input({ badgeType: "Presenter", registrationIds: ["gone", "other-event", "owing"] }));
    expect(skipsOf(result)).toEqual([["gone", "all", "CANCELLED"], ["other-event", "all", "NOT_FOUND"]]);
    expect(result).toMatchObject({ ok: true, changed: ["owing"] });
  });

  it("the single update's refusal (a stale write, a rule) is skipped with its message", async () => {
    updateSpy.mockResolvedValueOnce({ ok: false, code: "STALE_WRITE", message: "Changed by someone else" }).mockResolvedValue({ ok: true });
    const result = await bulkUpdateRegistrations(input({ paymentStatus: "COMPLIMENTARY" }));
    expect(result.ok && result.skipped).toEqual([{ registrationId: "owing", part: "paymentStatus", code: "REFUSED", message: "Changed by someone else" }]);
  });

  it("a row that throws is named and logged; the ones after it are still done", async () => {
    rows = [row("a"), row("b")];
    updateSpy.mockRejectedValueOnce(new Error("db blip")).mockResolvedValue({ ok: true });
    const result = await bulkUpdateRegistrations(input({ badgeType: "Presenter" }));
    expect(result).toMatchObject({ ok: true, changed: ["b"] });
    expect(skipsOf(result)).toEqual([["a", "all", "REFUSED"]]);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "registration-bulk-update:row-failed", registrationId: "a" }));
  });
});

describe("limits", () => {
  it("refuses nothing to do and too many, and never throws", async () => {
    expect(await bulkUpdateRegistrations(input({}))).toMatchObject({ ok: false, code: "NOTHING_TO_CHANGE" });
    expect(await bulkUpdateRegistrations(input({ badgeType: "X", registrationIds: [] }))).toMatchObject({ ok: false, code: "NOTHING_TO_CHANGE" });
    const tooMany = Array.from({ length: MAX_BULK_REGISTRATION_UPDATES + 1 }, (_, i) => `x${i}`);
    expect(await bulkUpdateRegistrations(input({ badgeType: "X", registrationIds: tooMany }))).toMatchObject({ ok: false, code: "TOO_MANY" });
    findMany.mockRejectedValueOnce(new Error("db down"));
    expect(await bulkUpdateRegistrations(input({ badgeType: "X" }))).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(logger.error).toHaveBeenCalled();
  });

  it("out of time, it stops and answers what it did not reach; the first is always attempted; an id named twice is done once", async () => {
    rows = [row("a"), row("b"), row("c")];
    const result = await bulkUpdateRegistrations(input({ badgeType: "Presenter", budgetMs: -1, registrationIds: ["a", "a", "b", "c"] }));
    expect(result).toMatchObject({ ok: true, changed: ["a"], remaining: ["b", "c"] });
  });
});
