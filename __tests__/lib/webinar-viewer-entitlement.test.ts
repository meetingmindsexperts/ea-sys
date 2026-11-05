/**
 * Who may watch a webinar (security review, Nov 5, 2026, W-01): confirmed or checked in, and paid
 * or nothing owed. A pending registration cannot watch (owner). Conferences keep the old rule.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { registration: { findMany: vi.fn() }, eventSession: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import {
  isViewerRoomOpen,
  resetRoomOpenCache,
  viewerRefusal,
  viewerRegistrationWhere,
} from "@/lib/webinar/viewer-entitlement";

beforeEach(() => {
  vi.clearAllMocks();
  resetRoomOpenCache();
});

describe("viewerRegistrationWhere", () => {
  it("on a webinar: confirmed or checked in, and paid or nothing charged (a rate's price wins over its type's)", () => {
    expect(viewerRegistrationWhere("ev1", "u1", "WEBINAR")).toEqual({
      eventId: "ev1",
      userId: "u1",
      status: { in: ["CONFIRMED", "CHECKED_IN"] },
      OR: [
        { paymentStatus: { in: ["PAID", "COMPLIMENTARY", "INCLUSIVE"] } },
        {
          OR: [
            // A free rate on a paid type owes nothing (review L2: an import marks it UNASSIGNED).
            { pricingTier: { price: 0 } },
            { pricingTierId: null, OR: [{ ticketTypeId: null }, { ticketType: { price: 0 } }] },
          ],
        },
      ],
    });
  });

  it("never lets PENDING, WAITLISTED or CANCELLED through on a webinar", () => {
    const statuses = (viewerRegistrationWhere("ev1", "u1", "WEBINAR").status as { in: string[] }).in;
    for (const s of ["PENDING", "WAITLISTED", "CANCELLED"]) expect(statuses).not.toContain(s);
  });

  it("a conference keeps the old rule: an in-person delegate paying at the desk still opens the link", () => {
    for (const t of ["CONFERENCE", "HYBRID", null]) {
      expect(viewerRegistrationWhere("ev1", "u1", t)).toEqual({ eventId: "ev1", userId: "u1", status: { not: "CANCELLED" } });
    }
  });
});

describe("viewerRefusal", () => {
  it("no live registration: null (the person is simply not registered)", async () => {
    mockDb.registration.findMany.mockResolvedValue([]);
    expect(await viewerRefusal("ev1", "u1")).toBeNull();
  });

  it("says why: pending approval first, then waitlisted, else the fee", async () => {
    mockDb.registration.findMany.mockResolvedValue([{ status: "WAITLISTED" }, { status: "PENDING" }]);
    expect(await viewerRefusal("ev1", "u1")).toBe("PENDING_APPROVAL");
    mockDb.registration.findMany.mockResolvedValue([{ status: "WAITLISTED" }]);
    expect(await viewerRefusal("ev1", "u1")).toBe("WAITLISTED");
    mockDb.registration.findMany.mockResolvedValue([{ status: "CONFIRMED" }]);
    expect(await viewerRefusal("ev1", "u1")).toBe("PAYMENT_OUTSTANDING");
  });
});

describe("isViewerRoomOpen", () => {
  const webinar = { id: "ev1", status: "PUBLISHED", eventType: "WEBINAR", settings: { webinar: { sessionId: "anchor" } } };

  it("reads the event's ANCHOR session, bound to the event: another session's id cannot open the room", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ status: "LIVE" });
    expect(await isViewerRoomOpen(webinar, "some-other-session")).toBe(true);
    expect(mockDb.eventSession.findFirst).toHaveBeenCalledWith({ where: { id: "anchor", eventId: "ev1" }, select: { status: true } });
  });

  it("closed unless the anchor is LIVE, and closed when no session is found", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ status: "SCHEDULED" });
    expect(await isViewerRoomOpen(webinar, "anchor")).toBe(false);
    resetRoomOpenCache();
    mockDb.eventSession.findFirst.mockResolvedValue(null);
    expect(await isViewerRoomOpen(webinar, "anchor")).toBe(false);
  });

  it("a dangling anchor pointer falls back to the URL's own session, as detail and lobby-status do (review M2)", async () => {
    mockDb.eventSession.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: "LIVE" });
    expect(await isViewerRoomOpen(webinar, "url-session")).toBe(true);
    expect(mockDb.eventSession.findFirst).toHaveBeenLastCalledWith({
      where: { id: "url-session", eventId: "ev1" },
      select: { status: true },
    });
  });

  it("a DRAFT webinar and any non-webinar event are open without a lookup", async () => {
    expect(await isViewerRoomOpen({ ...webinar, status: "DRAFT" }, "anchor")).toBe(true);
    expect(await isViewerRoomOpen({ ...webinar, eventType: "CONFERENCE" }, "s1")).toBe(true);
    expect(mockDb.eventSession.findFirst).not.toHaveBeenCalled();
  });

  it("is cached briefly, so 5k stream players do not each query the room", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ status: "LIVE" });
    await isViewerRoomOpen(webinar, "anchor");
    await isViewerRoomOpen(webinar, "anchor");
    expect(mockDb.eventSession.findFirst).toHaveBeenCalledTimes(1);
  });
});
