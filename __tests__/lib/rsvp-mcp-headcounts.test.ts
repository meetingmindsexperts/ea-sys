/**
 * MCP `list_rsvps` — headcounts must be computed over EVERY invite, never over
 * the truncated/filtered page (review H4).
 *
 * The tool used to fetch invites with `take: limit` (default 200) AND the
 * optional status filter, then feed that same array to the headcount helper
 * and to `summary.totalInvited`. The agent is the surface that briefs the
 * caterer — so it confidently reported a headcount for the oldest 200 of 260
 * invitees, and reported the page size as the total.
 *
 * Also pins the Aug 14, 2026 generalization: results are grouped BY campaign,
 * so a 30-person dinner and a 200-person workshop can never be added into one
 * meaningless number.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    rsvpCampaign: { findMany: vi.fn() },
    rsvpItem: { findMany: vi.fn() },
    rsvpInvite: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { RSVP_EXECUTORS } from "@/lib/agent/tools/rsvp";

const list = RSVP_EXECUTORS.list_rsvps;
const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1", counters: { creates: 0, emailsSent: 0 } };

const CAMPAIGNS = [
  {
    id: "c1",
    name: "Gala Dinner",
    description: null,
    selectionMode: "MULTI" as const,
    allowGuests: true,
    collectDietary: true,
    isActive: true,
  },
];
const ITEMS = [{ id: "d1", campaignId: "c1", name: "Gala", startsAt: new Date(), location: null }];

/** n invitees, each attending the gala with `guests` guests. */
function invitees(n: number, guests = 1) {
  return Array.from({ length: n }, () => ({
    campaignId: "c1",
    status: "RESPONDED" as const,
    inviteeName: "X",
    inviteeEmail: "x@x.com",
    dietary: null,
    respondedAt: new Date(),
    responses: [{ itemId: "d1", attending: true, guestCount: guests }],
  }));
}

type ListResult = {
  rsvps: Array<{
    id: string;
    name: string;
    headcountsByItem: Array<{ item: string; totalSeats: number }>;
    summary: { totalInvited: number };
  }>;
  summary: { totalInvited: number };
  inviteesTruncated: boolean;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "OSH" });
  mockDb.rsvpCampaign.findMany.mockResolvedValue(CAMPAIGNS);
  mockDb.rsvpItem.findMany.mockResolvedValue(ITEMS);
});

describe("H4 — headcounts are computed over ALL invites, not the page", () => {
  it("reports the full headcount even when the invitee list is truncated", async () => {
    const ALL = invitees(260); // the whole event
    const PAGE = invitees(200); // what a take:200 would return
    // 1st findMany call = the aggregate set; 2nd = the paged display set.
    mockDb.rsvpInvite.findMany.mockResolvedValueOnce(ALL).mockResolvedValueOnce(PAGE);

    const res = (await list({}, ctx)) as ListResult;

    // 260 attendees × (1 self + 1 guest) = 520 seats — NOT the 400 the old
    // code would have reported off the 200-row page.
    expect(res.rsvps[0].headcountsByItem[0].totalSeats).toBe(520);
    expect(res.summary.totalInvited).toBe(260); // not the page size
    expect(res.inviteesTruncated).toBe(true); // the agent can say "showing 200 of 260"
  });

  it("a status filter narrows the LIST but never the headcount", async () => {
    const ALL = invitees(10); // 10 responded, all attending
    const PAGE: ReturnType<typeof invitees> = []; // status:"PENDING" → nobody
    mockDb.rsvpInvite.findMany.mockResolvedValueOnce(ALL).mockResolvedValueOnce(PAGE);

    const res = (await list({ status: "PENDING" }, ctx)) as ListResult;

    // Old behavior: asking "who hasn't replied?" made every item report 0
    // seats, because headcounts were computed over the PENDING page.
    expect(res.rsvps[0].headcountsByItem[0].totalSeats).toBe(20);
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

describe("headcounts are grouped BY campaign, never summed across them", () => {
  it("keeps a 30-person dinner and a 200-person workshop separate", async () => {
    mockDb.rsvpCampaign.findMany.mockResolvedValue([
      { ...CAMPAIGNS[0], id: "c1", name: "Gala Dinner" },
      {
        id: "c2",
        name: "Workshops",
        description: null,
        selectionMode: "SINGLE" as const,
        allowGuests: false,
        collectDietary: false,
        isActive: true,
      },
    ]);
    mockDb.rsvpItem.findMany.mockResolvedValue([
      { id: "d1", campaignId: "c1", name: "Gala", startsAt: new Date(), location: null },
      { id: "w1", campaignId: "c2", name: "Workshop A", startsAt: new Date(), location: null },
    ]);

    const dinnerInvites = Array.from({ length: 3 }, () => ({
      campaignId: "c1",
      status: "RESPONDED" as const,
      inviteeName: "D",
      inviteeEmail: "d@x.com",
      dietary: null,
      respondedAt: new Date(),
      responses: [{ itemId: "d1", attending: true, guestCount: 1 }],
    }));
    const workshopInvites = Array.from({ length: 20 }, () => ({
      campaignId: "c2",
      status: "RESPONDED" as const,
      inviteeName: "W",
      inviteeEmail: "w@x.com",
      dietary: null,
      respondedAt: new Date(),
      responses: [{ itemId: "w1", attending: true, guestCount: 0 }],
    }));
    const ALL = [...dinnerInvites, ...workshopInvites];
    mockDb.rsvpInvite.findMany.mockResolvedValueOnce(ALL).mockResolvedValueOnce(ALL);

    const res = (await list({}, ctx)) as ListResult;

    const gala = res.rsvps.find((r) => r.id === "c1")!;
    const workshops = res.rsvps.find((r) => r.id === "c2")!;
    // 3 diners × (self + 1 guest) = 6 seats; the 20 workshop sign-ups must not
    // leak into the catering number.
    expect(gala.headcountsByItem[0].totalSeats).toBe(6);
    expect(gala.summary.totalInvited).toBe(3);
    expect(workshops.headcountsByItem[0].totalSeats).toBe(20);
    expect(workshops.summary.totalInvited).toBe(20);
  });

  it("campaignId narrows to one RSVP", async () => {
    mockDb.rsvpInvite.findMany.mockResolvedValueOnce(invitees(2)).mockResolvedValueOnce(invitees(2));
    await list({ campaignId: "c1" }, ctx);
    expect(mockDb.rsvpCampaign.findMany.mock.calls[0][0].where).toMatchObject({
      eventId: "ev1",
      id: "c1",
    });
  });

  it("an unknown campaignId is an error, not a silent empty result", async () => {
    mockDb.rsvpCampaign.findMany.mockResolvedValue([]);
    const res = (await list({ campaignId: "nope" }, ctx)) as { error?: string };
    expect(res.error).toMatch(/not found/i);
  });
});
