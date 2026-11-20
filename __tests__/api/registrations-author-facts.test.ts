/**
 * The Registrations list carries each row's abstract outcome and place on the
 * programme, and filters by them (owner, Nov 20, 2026; author-facts.ts). The
 * facts are read from the abstracts and sessions, never stored, and only for
 * a reader who may see abstracts and speakers on the event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockOrgCtx, logger } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    surveyResponse: { findMany: vi.fn().mockResolvedValue([]) },
    speaker: { findMany: vi.fn() },
  },
  mockOrgCtx: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/sponsors", () => ({
  getSponsors: vi.fn(async () => []),
  getSponsorNameMap: vi.fn(async () => new Map()),
  sponsorExistsOnEvent: vi.fn(async () => false),
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b, headers: { set: () => {} } }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: () => mockOrgCtx() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/schemas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/schemas")>()),
  titleEnum: { optional: () => ({}) },
}));

import { GET } from "@/app/api/events/[eventId]/registrations/route";

const row = (id: string, createdSource: string) => ({
  id, status: "CONFIRMED", paymentStatus: "COMPLIMENTARY", createdSource, attendee: { firstName: id, lastName: "X", email: `${id}@x.com`, tags: [] },
});
const REGS = [row("r-presenter", "PUBLIC_SUBMITTER"), row("r-rejected", "PUBLIC_SUBMITTER"), row("r-faculty", "SPEAKER_COMPANION"), row("r-delegate", "PUBLIC_REGISTER")];
const speaker = (id: string, over: Record<string, unknown>) => ({
  id, email: `${id}@elsewhere.com`, sourceRegistrationId: null, submitterSource: null, abstracts: [], sessionProposals: [], sessions: [], _count: { topicSpeakers: 0 }, ...over,
});
const abstract = (status: string) => ({ status, eventSession: null, sessionTopic: null });
const SPEAKERS = [
  speaker("s1", { sourceRegistrationId: "r-presenter", submitterSource: "abstract", abstracts: [abstract("ACCEPTED")] }),
  speaker("s2", { sourceRegistrationId: "r-rejected", submitterSource: "abstract", abstracts: [abstract("REJECTED")] }),
  speaker("s3", { sourceRegistrationId: "r-faculty", sessions: [{ session: { status: "SCHEDULED" } }] }),
];

const params = { params: Promise.resolve({ eventId: "ev1" }) };
// The Registrations page asks for the facts (`authorFacts=1`); a filter implies them.
const get = async (qs = "?authorFacts=1") => {
  const res = await GET(new Request(`http://localhost/x${qs}`), params);
  return { status: res.status, body: await res.json() };
};
const ids = (body: { id: string }[]) => body.map((r) => r.id);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", eventType: "CONFERENCE", staffAssignments: [] });
  mockDb.registration.findMany.mockResolvedValue(REGS.map((r) => ({ ...r })));
  mockDb.speaker.findMany.mockResolvedValue(SPEAKERS);
  mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: "ADMIN", userId: "a1" });
});

describe("the facts on each row", () => {
  it("an organiser's rows say who is a presenter, who was rejected, who is on the programme", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    const facts = Object.fromEntries(body.map((r: { id: string; abstractOutcome: unknown; speakerPlace: unknown }) => [r.id, [r.abstractOutcome, r.speakerPlace]]));
    expect(facts).toEqual({
      "r-presenter": ["accepted", null],
      "r-rejected": ["rejected", null],
      "r-faculty": [null, "programme"],
      "r-delegate": [null, null],
    });
  });

  // Review of b4493d67: check-in, the onsite desk, Communications and Invoices
  // load this list and use none of it. They do not ask, and are not charged the query.
  it("a reader of the list that does not ask gets no facts, and no extra query", async () => {
    const { status, body } = await get("");
    expect(status).toBe(200);
    expect("abstractOutcome" in body[0]).toBe(false);
    expect(mockDb.speaker.findMany).not.toHaveBeenCalled();
  });

  // Review of b4493d67 (MED): without this, removing the permission check passed every test.
  it("a role that reads registrations but not abstracts on this event gets no facts, and its filter is refused", async () => {
    // The webinar team on a conference: the desk surface, no abstracts.
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: "WEBINARS", userId: "w1" });
    const plain = await get();
    expect(plain.status).toBe(200);
    expect("abstractOutcome" in plain.body[0]).toBe(false);
    expect(mockDb.speaker.findMany).not.toHaveBeenCalled();
    const filtered = await get("?abstract=accepted");
    expect(filtered.status).toBe(403);
    expect(filtered.body.code).toBe("FILTER_NOT_PERMITTED");
  });

  it("an API key's rows are as they were: no facts, and no extra query", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: null, userId: null, fromApiKey: true });
    const { body } = await get();
    expect("abstractOutcome" in body[0]).toBe(false);
    expect(mockDb.speaker.findMany).not.toHaveBeenCalled();
  });

  // The facts follow the two keys that already open the Abstracts and Speakers
  // pages. The onsite desk holds both on an event it is assigned to (frozen in
  // system-role-grants-snapshot.test.ts), so it sees no more here than there.
  it("the onsite desk on its assigned event holds both keys, so it gets the facts", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: "ONSITE", userId: "o1" });
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", eventType: "CONFERENCE", staffAssignments: [{ userId: "o1" }] });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body[0].abstractOutcome).toBe("accepted");
  });
});

describe("the Abstract and Speaker filters", () => {
  it("narrow the rows by the same labels: presenters, rejected, no abstract, on the programme", async () => {
    expect(ids((await get("?abstract=accepted")).body)).toEqual(["r-presenter"]);
    expect(ids((await get("?abstract=rejected")).body)).toEqual(["r-rejected"]);
    expect(ids((await get("?abstract=none")).body)).toEqual(["r-faculty", "r-delegate"]);
    expect(ids((await get("?speaker=programme")).body)).toEqual(["r-faculty"]);
    // Authors are not speakers: "Not a speaker" is the delegates and the authors.
    expect(ids((await get("?speaker=none")).body)).toEqual(["r-presenter", "r-rejected", "r-delegate"]);
    expect(ids((await get("?abstract=rejected&speaker=none")).body)).toEqual(["r-rejected"]);
  });

  it("an unknown value is refused and logged, not ignored", async () => {
    const { status, body } = await get("?abstract=ACCEPTED");
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_FILTER");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "events/registrations:invalid-author-filter" }));
  });

  // An ignored filter would return the whole list as if it were the subset.
  it("a filter from a caller who gets no facts is refused, never ignored", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: null, userId: null, fromApiKey: true });
    const { status, body } = await get("?abstract=accepted");
    expect(status).toBe(403);
    expect(body.code).toBe("FILTER_NOT_PERMITTED");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "events/registrations:author-filter-not-permitted" }));
  });
});
