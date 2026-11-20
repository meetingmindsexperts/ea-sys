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
  id, status: "CONFIRMED", paymentStatus: "COMPLIMENTARY", createdSource, attendee: { firstName: id, lastName: "X", tags: [] },
});
const REGS = [row("r-presenter", "PUBLIC_SUBMITTER"), row("r-rejected", "PUBLIC_SUBMITTER"), row("r-faculty", "SPEAKER_COMPANION"), row("r-delegate", "PUBLIC_REGISTER")];
const SPEAKERS = [
  { sourceRegistrationId: "r-presenter", abstracts: [{ status: "ACCEPTED" }], _count: { sessions: 0, topicSpeakers: 0 } },
  { sourceRegistrationId: "r-rejected", abstracts: [{ status: "REJECTED" }], _count: { sessions: 0, topicSpeakers: 0 } },
  { sourceRegistrationId: "r-faculty", abstracts: [], _count: { sessions: 1, topicSpeakers: 0 } },
];

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const get = async (qs = "") => {
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
      "r-presenter": ["accepted", "record"],
      "r-rejected": ["rejected", "record"],
      "r-faculty": [null, "programme"],
      "r-delegate": [null, null],
    });
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
    expect(ids((await get("?speaker=none")).body)).toEqual(["r-delegate"]);
    expect(ids((await get("?abstract=rejected&speaker=record")).body)).toEqual(["r-rejected"]);
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
