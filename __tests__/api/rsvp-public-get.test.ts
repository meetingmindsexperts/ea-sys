/**
 * GET /api/public/events/{slug}/rsvp/{token} (review of 3b8d4f365): what the invitee's page is
 * given. Reached with a token alone, so this pins exactly what is new in the answer: the three
 * texts on the campaign and the title as a label, and that the ids the title was read through
 * never leave the server.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    rsvpInvite: { findUnique: vi.fn() },
    rsvpItem: { findMany: vi.fn() },
    rsvpResponse: { findMany: vi.fn() },
    speaker: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }), getClientIp: () => "1.1.1.1" }));
vi.mock("@/lib/public-event", () => ({ eventMatchesRequestTenant: async () => true }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/tenant/event-tenant", () => ({ resolvePublicEventOrg: async () => "org1", findGatedEvent: vi.fn() }));

import { GET } from "@/app/api/public/events/[slug]/rsvp/[token]/route";

const FUTURE = new Date(Date.now() + 7 * 86_400_000);
const invite = (over: Record<string, unknown> = {}) => ({
  id: "inv1",
  eventId: "ev1",
  campaignId: "c1",
  inviteeName: "Hadeel Ammar",
  inviteeEmail: "hadeel@example.com",
  registrationId: "reg1",
  speakerId: null,
  dietary: null,
  status: "PENDING",
  campaign: {
    id: "c1",
    name: "Dinner RSVP",
    description: "An evening of dinner and gathering.",
    questionText: "Will you join us?",
    questionHelpText: null,
    thankYouText: "See you on Saturday.",
    selectionMode: "MULTI",
    allowGuests: false,
    collectDietary: false,
    isActive: true,
  },
  event: { slug: "gala", organizationId: "org1", name: "Gala", bannerImage: null, bannerImageMobile: null, startDate: FUTURE, endDate: FUTURE, timezone: "Asia/Dubai" },
  responses: [],
  ...over,
});
const get = async () => {
  const res = await GET(new Request("http://t/api/public/events/gala/rsvp/tok"), { params: Promise.resolve({ slug: "gala", token: "tok" }) });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.rsvpInvite.findUnique.mockResolvedValue(invite());
  mockDb.rsvpItem.findMany.mockResolvedValue([{ id: "A", name: "Dinner", startsAt: FUTURE, location: null, description: null, rsvpDeadline: null, capacity: null }]);
  mockDb.rsvpResponse.findMany.mockResolvedValue([]);
  mockDb.speaker.findFirst.mockResolvedValue(null);
  mockDb.registration.findFirst.mockResolvedValue({ attendee: { title: "DR" } });
});

describe("what the invitee's page is given", () => {
  it("the organiser's three texts, and the title as a label, never the stored key", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.campaign).toMatchObject({ questionText: "Will you join us?", questionHelpText: null, thankYouText: "See you on Saturday." });
    expect(body.invitee).toEqual({ name: "Hadeel Ammar", title: "Dr.", email: "hadeel@example.com", dietary: "" });
  });

  it("the ids the title was read through stay on the server", async () => {
    const { body } = await get();
    const text = JSON.stringify(body);
    expect(text).not.toContain("reg1");
    expect(text).not.toContain("registrationId");
    expect(text).not.toContain("speakerId");
  });

  it("the linked registration answers only while it is on this event, not cancelled, and still on the invitee's own address", async () => {
    await get();
    expect(mockDb.registration.findFirst.mock.calls[0][0].where).toEqual({
      id: "reg1",
      eventId: "ev1",
      status: { not: "CANCELLED" },
      attendee: { email: { equals: "hadeel@example.com", mode: "insensitive" } },
    });
  });

  it("no title on record: an empty title, and the page greets by name alone", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    expect((await get()).body.invitee.title).toBe("");
  });

  it("a failed title lookup never costs the invitee their form: logged as an error, the name alone", async () => {
    mockDb.registration.findFirst.mockRejectedValue(new Error("db down"));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.invitee.title).toBe("");
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ inviteId: "inv1" }), "rsvp-public:title-lookup-failed");
  });
});
