/**
 * Who may watch a webinar (security review, Nov 5, 2026, W-01): confirmed or checked in, and paid
 * or nothing owed. A pending registration cannot watch (owner). Conferences keep the old rule.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockWarn } = vi.hoisted(() => ({
  mockDb: { registration: { findMany: vi.fn() }, eventSession: { findFirst: vi.fn() }, user: { findUnique: vi.fn() } },
  mockWarn: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: mockWarn, error: vi.fn() } }));

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  isViewerRoomOpen,
  resetRoomOpenCache,
  resetViewerAddressCache,
  viewerAccessWhere,
  viewerRefusal,
  viewerRegistrationWhere,
  viewerStandingWhere,
} from "@/lib/webinar/viewer-entitlement";

beforeEach(() => {
  vi.clearAllMocks();
  resetRoomOpenCache();
  resetViewerAddressCache();
  mockDb.user.findUnique.mockResolvedValue({ email: "Jane.Doe@Hospital.org " });
});

/**
 * Owner, Nov 24, 2026: someone with an older account who registered for a webinar without signing
 * in was told "Register to join" until they confirmed their address with the old account's
 * password. 6 of the 120 registered for that evening's webinar were in that state.
 */
describe("viewerAccessWhere: a free webinar is also watched through an unheld registration on the account's own address", () => {
  const FREE = {
    OR: [
      { pricingTier: { price: 0 } },
      { pricingTierId: null, OR: [{ ticketTypeId: null }, { ticketType: { price: 0 } }] },
    ],
  };

  it("on a webinar: the account's own registration, or one on its address that no account holds and that owes nothing", async () => {
    expect(await viewerAccessWhere("ev1", "u1", "WEBINAR")).toEqual({
      eventId: "ev1",
      AND: [
        viewerStandingWhere("WEBINAR"),
        {
          OR: [
            { userId: "u1" },
            // The escaped, case-blind match (like-escape.ts), on the address as the database holds it.
            { AND: [{ userId: null }, { attendee: { email: { equals: "jane.doe@hospital.org", mode: "insensitive" } } }, FREE] },
          ],
        },
      ],
    });
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { email: true } });
  });

  it("the address branch never reaches a registration another account holds", async () => {
    const where = await viewerAccessWhere("ev1", "u1", "WEBINAR");
    const branch = ((where.AND as unknown[])[1] as { OR: { AND?: unknown[] }[] }).OR[1].AND!;
    expect(branch[0]).toEqual({ userId: null });
  });

  it("the address branch is for a registration with no price: a paid seat still needs the account", async () => {
    const where = await viewerAccessWhere("ev1", "u1", "WEBINAR");
    const branch = ((where.AND as unknown[])[1] as { OR: { AND?: unknown[] }[] }).OR[1].AND!;
    expect(branch[2]).toEqual(FREE);
    // And the standing rule (confirmed, never pending) holds for both branches.
    expect((where.AND as unknown[])[0]).toEqual(viewerStandingWhere("WEBINAR"));
  });

  it("an underscore in the address matches only itself", async () => {
    mockDb.user.findUnique.mockResolvedValue({ email: "john_smith@x.org" });
    const where = await viewerAccessWhere("ev1", "u9", "WEBINAR");
    expect(JSON.stringify(where)).toContain("john\\\\_smith@x.org");
  });

  it.each(["CONFERENCE", "HYBRID", null])("a %s event keeps the account-only rule, and no address is read", async (eventType) => {
    expect(await viewerAccessWhere("ev1", "u1", eventType)).toEqual(viewerRegistrationWhere("ev1", "u1", eventType));
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["the account is gone", null],
    ["the account has no address", { email: "" }],
  ])("when %s the account-only rule stands", async (_name, user) => {
    mockDb.user.findUnique.mockResolvedValue(user);
    expect(await viewerAccessWhere("ev1", "u1", "WEBINAR")).toEqual(viewerRegistrationWhere("ev1", "u1", "WEBINAR"));
  });

  it("when the address cannot be read the account-only rule stands, it is logged, and the next request asks again", async () => {
    mockDb.user.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await viewerAccessWhere("ev1", "u1", "WEBINAR")).toEqual(viewerRegistrationWhere("ev1", "u1", "WEBINAR"));
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: "webinar-viewer:address-read-failed", userId: "u1" }));
    await viewerAccessWhere("ev1", "u1", "WEBINAR");
    expect(mockDb.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it("the address is read once a minute per viewer, not on every poll", async () => {
    await viewerAccessWhere("ev1", "u1", "WEBINAR");
    await viewerAccessWhere("ev1", "u1", "WEBINAR");
    await viewerAccessWhere("ev2", "u1", "WEBINAR");
    expect(mockDb.user.findUnique).toHaveBeenCalledTimes(1);
    await viewerAccessWhere("ev1", "u2", "WEBINAR");
    expect(mockDb.user.findUnique).toHaveBeenCalledTimes(2);
  });

  // Every attendee route goes through the one function. A route that asked the
  // account-only half would bring "Register to join" back for these people.
  it("no file outside the rule names the account-only half, and every attendee route asks the whole rule", () => {
    const SRC = join(process.cwd(), "src");
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return files(path);
        return /\.(ts|tsx)$/.test(name) ? [path] : [];
      });
    const naming = (mark: string) =>
      files(SRC)
        .filter((path) => readFileSync(path, "utf8").includes(mark))
        .map((path) => path.slice(SRC.length + 1))
        .sort();

    expect(naming("viewerRegistrationWhere")).toEqual(["lib/webinar/viewer-entitlement.ts"]);
    expect(naming("viewerAccessWhere(")).toEqual([
      "app/api/public/events/[slug]/sessions/[sessionId]/end-survey/route.ts",
      "app/api/public/events/[slug]/sessions/[sessionId]/presence/route.ts",
      "app/api/public/events/[slug]/sessions/[sessionId]/recording/route.ts",
      "app/api/public/events/[slug]/sessions/[sessionId]/stream-status/route.ts",
      "app/api/public/events/[slug]/sessions/[sessionId]/zoom-join/route.ts",
      "lib/webinar/viewer-entitlement.ts",
      "lib/webinar/viewer-question-access.ts",
    ]);
  });
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

  it("is the standing rule plus whose registration it is: the portal's replay page reuses the standing half (Nov 10, 2026)", () => {
    for (const t of ["WEBINAR", "CONFERENCE", null]) {
      const standing = viewerStandingWhere(t);
      expect(standing).not.toHaveProperty("eventId");
      expect(standing).not.toHaveProperty("userId");
      expect(viewerRegistrationWhere("ev1", "u1", t)).toEqual({ eventId: "ev1", userId: "u1", ...standing });
    }
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
