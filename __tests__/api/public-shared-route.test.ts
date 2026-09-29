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
