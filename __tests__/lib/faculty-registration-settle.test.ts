/**
 * A confirmed speaker's Faculty registration is confirmed and complimentary
 * (owner, Nov 12, 2026). On the 4th GCC Hematology Hub 19 confirmed speakers
 * held a registration that read Pending and Unpaid.
 *
 * The lines this draws matter more than the happy path: a registration on a
 * delegate type is the person's own and is never made free from here, and a
 * registration that money has touched is never relabelled.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLog, mockRefresh } = vi.hoisted(() => ({
  mockDb: {
    registration: { findFirst: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockRefresh: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLog }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: mockRefresh }));

import { planFacultySettle, settleFacultyRegistration } from "@/lib/speaker-companion";
import { registrationSettleNotice } from "@/lib/speaker-registration-messages";

const reg = (extra: Record<string, unknown> = {}) => ({
  id: "reg-1", status: "PENDING", paymentStatus: "UNPAID", ticketType: { isFaculty: true }, ...extra,
});
const settle = () =>
  settleFacultyRegistration({ eventId: "evt-1", registrationId: "reg-1", reason: "speaker-confirmed", speakerId: "spk-1", source: "rest", actorUserId: "user-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.findFirst.mockResolvedValue(reg());
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
  mockDb.auditLog.create.mockReturnValue({ catch: () => {} });
});

describe("planFacultySettle", () => {
  it.each(["PENDING", "WAITLISTED"])("confirms a %s registration", (status) => {
    expect(planFacultySettle({ status, paymentStatus: "COMPLIMENTARY" })).toEqual({ confirm: true, comp: false });
  });
  it.each(["UNPAID", "UNASSIGNED"])("makes %s complimentary", (paymentStatus) => {
    expect(planFacultySettle({ status: "CONFIRMED", paymentStatus })).toEqual({ confirm: false, comp: true });
  });
  it.each(["PAID", "PENDING", "FAILED", "REFUNDED", "INCLUSIVE", "COMPLIMENTARY"])("never relabels a %s payment", (paymentStatus) => {
    expect(planFacultySettle({ status: "CONFIRMED", paymentStatus }).comp).toBe(false);
  });
  it("leaves a checked-in registration's status, and still settles its payment", () => {
    expect(planFacultySettle({ status: "CHECKED_IN", paymentStatus: "UNPAID" })).toEqual({ confirm: false, comp: true });
  });
  it("changes nothing on a cancelled registration, payment included", () => {
    expect(planFacultySettle({ status: "CANCELLED", paymentStatus: "UNPAID" })).toEqual({ confirm: false, comp: false });
  });
});

describe("settleFacultyRegistration", () => {
  it("confirms and comps a pending, unpaid Faculty registration, bound to the state it read", async () => {
    expect(await settle()).toEqual({ outcome: "settled", registrationId: "reg-1" });
    expect(mockDb.registration.findFirst.mock.calls[0][0].where).toEqual({ id: "reg-1", eventId: "evt-1" });
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg-1", eventId: "evt-1", status: "PENDING", paymentStatus: "UNPAID" },
      data: { status: "CONFIRMED", paymentStatus: "COMPLIMENTARY" },
    });
    expect(mockRefresh).toHaveBeenCalledWith("evt-1");
  });

  it("writes an audit row with before and after, and why", async () => {
    await settle();
    const data = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ eventId: "evt-1", userId: "user-1", action: "FACULTY_REGISTRATION_SETTLED", entityType: "Registration", entityId: "reg-1" });
    expect(data.changes).toEqual({
      source: "rest", reason: "speaker-confirmed", speakerId: "spk-1",
      before: { status: "PENDING", paymentStatus: "UNPAID" },
      after: { status: "CONFIRMED", paymentStatus: "COMPLIMENTARY" },
    });
  });

  // The line that protects revenue: an abstract presenter, or a delegate who
  // was later invited to speak, holds a registration on a delegate type.
  it("never touches a registration on a delegate type, and says so", async () => {
    mockDb.registration.findFirst.mockResolvedValue(reg({ ticketType: { isFaculty: false } }));
    expect(await settle()).toEqual({ outcome: "not-faculty", registrationId: "reg-1" });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(expect.objectContaining({ msg: "faculty-registration:settle-skipped-not-faculty", registrationId: "reg-1" }));
  });

  it("never touches a registration with no type", async () => {
    mockDb.registration.findFirst.mockResolvedValue(reg({ ticketType: null }));
    expect((await settle()).outcome).toBe("not-faculty");
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("confirms a pending registration whose payment is already settled, and leaves the payment", async () => {
    mockDb.registration.findFirst.mockResolvedValue(reg({ paymentStatus: "PAID" }));
    expect((await settle()).outcome).toBe("settled");
    expect(mockDb.registration.updateMany.mock.calls[0][0].data).toEqual({ status: "CONFIRMED" });
  });

  it.each([
    ["already confirmed and complimentary", { status: "CONFIRMED", paymentStatus: "COMPLIMENTARY" }],
    ["cancelled", { status: "CANCELLED", paymentStatus: "UNPAID" }],
    ["checked in and paid", { status: "CHECKED_IN", paymentStatus: "PAID" }],
  ])("changes nothing when the registration is %s", async (_label, state) => {
    mockDb.registration.findFirst.mockResolvedValue(reg(state));
    expect((await settle()).outcome).toBe("unchanged");
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("gives way to a change made in between, and logs it", async () => {
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    expect((await settle()).outcome).toBe("unchanged");
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "faculty-registration:settle-lost-race" }));
  });

  it("answers none for a speaker with no registration, or one on another event", async () => {
    expect(await settleFacultyRegistration({ eventId: "evt-1", registrationId: null, reason: "speaker-confirmed", source: "rest" })).toEqual({ outcome: "none" });
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
    mockDb.registration.findFirst.mockResolvedValue(null);
    expect((await settle()).outcome).toBe("none");
  });

  it("never throws: a failed write is an outcome and an error log", async () => {
    mockDb.registration.updateMany.mockRejectedValue(new Error("db down"));
    expect(await settle()).toEqual({ outcome: "failed", registrationId: "reg-1" });
    expect(mockLog.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "faculty-registration:settle-failed" }));
  });
});

describe("registrationSettleNotice", () => {
  it("says what happened, and stays silent when nothing did", () => {
    expect(registrationSettleNotice("settled")).toEqual({ kind: "info", text: "Their Faculty registration is now Confirmed and Complimentary." });
    expect(registrationSettleNotice("not-faculty")?.text).toContain("delegate type");
    expect(registrationSettleNotice("failed")?.kind).toBe("error");
    expect([registrationSettleNotice("none"), registrationSettleNotice("unchanged"), registrationSettleNotice(undefined)]).toEqual([null, null, null]);
  });
});
