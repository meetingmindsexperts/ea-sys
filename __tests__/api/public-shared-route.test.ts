/**
 * Shared submission view, public side (Sep 29, 2026). What a stranger holding
 * the link can and cannot get.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { loggerMock } = vi.hoisted(() => ({ loggerMock: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ apiLogger: loggerMock }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
const rate = vi.hoisted(() => ({ allowed: true, retryAfterSeconds: 0 }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => rate, getClientIp: () => "1.2.3.4" }));
const tenant = vi.hoisted(() => ({ match: true }));
vi.mock("@/lib/public-event", () => ({
  publicEventWhere: async (_req: Request, slug: string) => ({ slug }),
  eventMatchesRequestTenant: async () => tenant.match,
}));

const mockDb = vi.hoisted(() => ({
  event: { findFirst: vi.fn() },
  submissionShareLink: { findUnique: vi.fn() },
  abstract: { findMany: vi.fn() },
  registrationShareLink: { findUnique: vi.fn() },
  registration: { findMany: vi.fn() },
  sessionProposal: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { GET } from "@/app/api/public/events/[slug]/shared/[token]/route";

const TOKEN = "t".repeat(43);
const call = (token = TOKEN) =>
  GET(new Request(`http://localhost/api/public/events/cardio/shared/${token}`), { params: Promise.resolve({ slug: "cardio", token }) });

const EVENT = {
  id: "ev1",
  organizationId: "org1",
  name: "Cardio 2027",
  startDate: new Date(),
  endDate: new Date(),
  timezone: "Asia/Dubai",
  bannerImage: null,
  bannerImageMobile: null,
  organization: { name: "MMG", logo: null },
};
const LINK = { id: "l1", eventId: "ev1", organizationId: "org1", kind: "ABSTRACTS", enabled: true, statuses: ["ACCEPTED", "DRAFT"], fields: ["content"] };
const ROW = {
  serialId: 1,
  title: "T",
  content: "Body",
  status: "ACCEPTED",
  presentationType: null,
  specialty: null,
  coAuthors: null,
  submittedAt: new Date(),
  theme: null,
  subTheme: null,
  track: null,
  speaker: { title: null, firstName: "A", lastName: "B", organization: null, jobTitle: null, country: null, email: "a@b.com", phone: "+971" },
};

beforeEach(() => {
  vi.clearAllMocks();
  rate.allowed = true;
  tenant.match = true;
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.submissionShareLink.findUnique.mockResolvedValue(LINK);
  mockDb.abstract.findMany.mockResolvedValue([ROW]);
  mockDb.sessionProposal.findMany.mockResolvedValue([]);
  mockDb.registrationShareLink.findUnique.mockResolvedValue(null);
  mockDb.registration.findMany.mockResolvedValue([]);
});

describe("public shared view", () => {
  it("returns only the switched-on fields, never contact data it did not ask for, and no-store", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    const body = await res.json();
    expect(body.items).toEqual([{ number: "A-001", title: "T", body: "Body" }]);
    expect(JSON.stringify(body)).not.toContain("a@b.com");
    // The contact columns were not even selected.
    const sel = mockDb.abstract.findMany.mock.calls[0][0].select.speaker.select;
    expect(sel).not.toHaveProperty("email");
    expect(sel).not.toHaveProperty("phone");
  });

  it("queries only the link's shareable statuses (a stored DRAFT is dropped)", async () => {
    await call();
    expect(mockDb.abstract.findMany.mock.calls[0][0].where).toEqual({ eventId: "ev1", status: { in: ["ACCEPTED"] } });
  });

  it("shows contact details when the organiser switched them on", async () => {
    mockDb.submissionShareLink.findUnique.mockResolvedValue({ ...LINK, fields: ["authorEmail"] });
    const body = await (await call()).json();
    expect(mockDb.abstract.findMany.mock.calls[0][0].select.speaker.select).toHaveProperty("email", true);
    expect(body.items[0].authorEmail).toBe("a@b.com");
  });

  it("an unknown token, another event's token, a switched-off link and a tenant mismatch all give the same 404", async () => {
    const cases: (() => void)[] = [
      () => mockDb.submissionShareLink.findUnique.mockResolvedValue(null),
      () => mockDb.submissionShareLink.findUnique.mockResolvedValue({ ...LINK, eventId: "other" }),
      () => mockDb.submissionShareLink.findUnique.mockResolvedValue({ ...LINK, enabled: false }),
      () => { tenant.match = false; },
      () => mockDb.event.findFirst.mockResolvedValue(null),
    ];
    const bodies: unknown[] = [];
    for (const arrange of cases) {
      vi.clearAllMocks();
      tenant.match = true;
      mockDb.event.findFirst.mockResolvedValue(EVENT);
      mockDb.submissionShareLink.findUnique.mockResolvedValue(LINK);
      arrange();
      const res = await call();
      expect(res.status).toBe(404);
      bodies.push(await res.json());
      expect(mockDb.abstract.findMany).not.toHaveBeenCalled();
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("refuses a malformed token without touching the database", async () => {
    expect((await call("short")).status).toBe(404);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("rate-limits per IP", async () => {
    rate.allowed = false;
    rate.retryAfterSeconds = 30;
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("session proposals read their own table", async () => {
    mockDb.submissionShareLink.findUnique.mockResolvedValue({ ...LINK, kind: "SESSION_PROPOSALS", statuses: ["SUBMITTED", "WITHDRAWN"], fields: ["description"] });
    const body = await (await call()).json();
    expect(body.kind).toBe("SESSION_PROPOSALS");
    expect(mockDb.sessionProposal.findMany.mock.calls[0][0].where).toEqual({ eventId: "ev1", status: { in: ["SUBMITTED"] } });
    expect(mockDb.abstract.findMany).not.toHaveBeenCalled();
  });
});

describe("public shared view: registration views", () => {
  const VIEW = {
    id: "rv1",
    eventId: "ev1",
    label: "Sponsorship team",
    enabled: true,
    expiresAt: null,
    statuses: ["CONFIRMED", "CHECKED_IN", "BOGUS"],
    fields: ["organization", "promoCode", "originalPrice"],
    ticketTypeIds: ["tt1"],
    sponsorIds: ["sp1"],
    promoCodeIds: [],
    includeFaculty: false,
  };
  const REG = {
    serialId: 7,
    status: "CONFIRMED",
    attendanceMode: "IN_PERSON",
    checkedInAt: null,
    createdAt: new Date(),
    ticketType: { name: "Physician", isFaculty: false },
    promoCode: { code: "PFIZER", sponsor: null },
    sponsor: { name: "Pfizer" },
    group: null,
    attendee: { title: null, firstName: "Lina", lastName: "Saad", organization: "Tawam", jobTitle: null, country: null, specialty: null, customSpecialty: null, registrationType: null },
  };

  beforeEach(() => {
    mockDb.submissionShareLink.findUnique.mockResolvedValue(null);
    mockDb.registrationShareLink.findUnique.mockResolvedValue(VIEW);
    mockDb.registration.findMany.mockResolvedValue([REG]);
  });

  it("returns only the view's fields and a summary, filtered as configured, faculty excluded", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ kind: "REGISTRATIONS", label: "Sponsorship team", fields: ["organization", "promoCode"] });
    expect(body.items).toEqual([{ number: "007", name: "Lina Saad", organization: "Tawam", promoCode: "PFIZER" }]);
    expect(body.summary).toMatchObject({ total: 1, checkedIn: 0 });
    const q = mockDb.registration.findMany.mock.calls[0][0];
    expect(q.where).toEqual({
      eventId: "ev1",
      status: { in: ["CONFIRMED", "CHECKED_IN"] },
      AND: [
        { NOT: { ticketType: { isFaculty: true } } },
        { ticketTypeId: { in: ["tt1"] } },
        // All three attribution arms (review M1), not only the direct tag.
        {
          OR: [
            { sponsorId: { in: ["sp1"] } },
            { promoCode: { sponsorId: { in: ["sp1"] } } },
            { group: { promoCode: { sponsorId: { in: ["sp1"] } } } },
          ],
        },
      ],
    });
    expect(q.select.attendee.select).not.toHaveProperty("email");
    expect(q.select.attendee.select).not.toHaveProperty("phone");
    // Nothing money-shaped is even selected.
    expect(Object.keys(q.select)).not.toEqual(expect.arrayContaining(["originalPrice"]));
    expect(q.select).not.toHaveProperty("paymentStatus");
    expect(q.select).not.toHaveProperty("originalPrice");
  });

  it("an expired, switched-off or other-event view gives the same 404 as an unknown token", async () => {
    const expected = await (async () => {
      mockDb.registrationShareLink.findUnique.mockResolvedValueOnce(null);
      return (await call()).json();
    })();
    for (const v of [{ ...VIEW, expiresAt: new Date(Date.now() - 1000) }, { ...VIEW, enabled: false }, { ...VIEW, eventId: "other" }]) {
      mockDb.registration.findMany.mockClear();
      mockDb.registrationShareLink.findUnique.mockResolvedValueOnce(v);
      const res = await call();
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(expected);
      expect(mockDb.registration.findMany).not.toHaveBeenCalled();
    }
  });

  it("includeFaculty drops the faculty exclusion", async () => {
    mockDb.registrationShareLink.findUnique.mockResolvedValue({ ...VIEW, includeFaculty: true, ticketTypeIds: [], sponsorIds: [] });
    await call();
    expect(mockDb.registration.findMany.mock.calls[0][0].where.AND).toEqual([]);
  });
});
