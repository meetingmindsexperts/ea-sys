/**
 * MCP `list_dinner_rsvps` — headcounts must be computed over EVERY invite,
 * never over the truncated/filtered page (review H4).
 *
 * The tool used to fetch invites with `take: limit` (default 200) AND the
 * optional status filter, then feed that same array to computeDinnerHeadcounts
 * and to `summary.totalInvited`. The agent is the surface that briefs the
 * caterer — so it confidently reported a headcount for the oldest 200 of 260
 * invitees, and reported the page size as the total.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    rsvpDinner: { findMany: vi.fn() },
    rsvpInvite: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { DINNER_EXECUTORS } from "@/lib/agent/tools/dinner";

const list = DINNER_EXECUTORS.list_dinner_rsvps;
const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1", counters: { creates: 0, emailsSent: 0 } };

const DINNERS = [{ id: "d1", name: "Gala", dinnerAt: new Date(), location: null }];

/** n invitees, each attending the gala with `guests` guests. */
function invitees(n: number, guests = 1) {
  return Array.from({ length: n }, () => ({
    status: "RESPONDED" as const,
    inviteeName: "X",
    inviteeEmail: "x@x.com",
    dietary: null,
    respondedAt: new Date(),
    responses: [{ dinnerId: "d1", attending: true, guestCount: guests }],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "OSH" });
  mockDb.rsvpDinner.findMany.mockResolvedValue(DINNERS);
});

describe("H4 — headcounts are computed over ALL invites, not the page", () => {
  it("reports the full headcount even when the invitee list is truncated", async () => {
    const ALL = invitees(260); // the whole event
    const PAGE = invitees(200); // what a take:200 would return
    // 1st findMany call = the aggregate set; 2nd = the paged display set.
    mockDb.rsvpInvite.findMany.mockResolvedValueOnce(ALL).mockResolvedValueOnce(PAGE);

    const res = (await list({}, ctx)) as {
      headcountsByDinner: Array<{ dinner: string; totalSeats: number }>;
      summary: { totalInvited: number };
      inviteesTruncated: boolean;
    };

    // 260 attendees × (1 self + 1 guest) = 520 seats — NOT the 400 the old
    // code would have reported off the 200-row page.
    expect(res.headcountsByDinner[0].totalSeats).toBe(520);
    expect(res.summary.totalInvited).toBe(260); // not the page size
    expect(res.inviteesTruncated).toBe(true); // the agent can say "showing 200 of 260"
  });

  it("a status filter narrows the LIST but never the headcount", async () => {
    const ALL = invitees(10); // 10 responded, all attending
    const PAGE: ReturnType<typeof invitees> = []; // status:"PENDING" → nobody
    mockDb.rsvpInvite.findMany.mockResolvedValueOnce(ALL).mockResolvedValueOnce(PAGE);

    const res = (await list({ status: "PENDING" }, ctx)) as {
      headcountsByDinner: Array<{ totalSeats: number }>;
      summary: { totalInvited: number };
    };

    // Old behavior: asking "who hasn't replied?" made every dinner report 0
    // seats, because headcounts were computed over the PENDING page.
    expect(res.headcountsByDinner[0].totalSeats).toBe(20);
    expect(res.summary.totalInvited).toBe(10);
  });

  it("the aggregate query is unfiltered and untaken", async () => {
    mockDb.rsvpInvite.findMany.mockResolvedValueOnce(invitees(3)).mockResolvedValueOnce(invitees(3));
    await list({ status: "RESPONDED", limit: 2 }, ctx);

    const aggregateQuery = mockDb.rsvpInvite.findMany.mock.calls[0][0];
    expect(aggregateQuery.take).toBeUndefined(); // no truncation
    expect(aggregateQuery.where.status).toBeUndefined(); // no status filter
  });
});
