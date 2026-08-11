/**
 * Per-event abstract limits, enforced at the route (Aug 11, 2026).
 *
 * The reader has its own unit suite. What these pin is REACHABILITY: that the
 * create and update handlers actually consult it, and that each limit bites in
 * the right place. The distinction matters because three separate defects this
 * month were correct, fully-tested code that nothing ever called.
 *
 * Two rules under test, both owner decisions:
 *   * format limits (title, body, co-authors) apply to drafts as well, but a
 *     value already over a newly-lowered cap may be KEPT or trimmed;
 *   * the per-person cap governs the review POOL, so it bites only at Submit,
 *     only for a SUBMITTER, and drafts/withdrawn/rejected do not occupy a slot.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: {
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    speaker: { findFirst: vi.fn() },
    track: { findFirst: vi.fn() },
    abstractTheme: { findFirst: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    abstractSubTheme: { findFirst: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb),
}));
vi.mock("@/lib/abstract-serial", () => ({
  getNextAbstractSerialId: vi.fn().mockResolvedValue(7),
  formatAbstractSerial: (n: number | null | undefined) => (n == null ? "-" : `A-${n}`),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (_u: unknown, id: string) => ({ id }),
}));
vi.mock("@/services/abstract-service", () => ({ changeAbstractStatus: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  notifyEventAdmins: vi.fn().mockReturnValue({ catch: () => {} }),
}));
vi.mock("@/lib/abstract-notifications", () => ({
  sendAbstractSubmissionConfirmation: vi.fn().mockResolvedValue(undefined),
  notifyAbstractStatusChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  getEventTemplate: vi.fn(),
  getDefaultTemplate: vi.fn(),
  renderAndWrap: vi.fn(),
  brandingFrom: vi.fn(),
  brandingCc: vi.fn(),
}));

import { POST as CREATE } from "@/app/api/events/[eventId]/abstracts/route";
import { PUT } from "@/app/api/events/[eventId]/abstracts/[abstractId]/route";

const createParams = { params: Promise.resolve({ eventId: "ev1" }) };
const putParams = { params: Promise.resolve({ eventId: "ev1", abstractId: "ab1" }) };

const ADMIN = { user: { id: "admin1", role: "ADMIN", organizationId: "org1" } };
const SUBMITTER = { user: { id: "u1", role: "SUBMITTER", organizationId: null } };

/** A speaker row that clears the profile-completeness gate. */
const COMPLETE_SPEAKER = {
  id: "spk1",
  userId: "u1",
  eventId: "ev1",
  role: "PHYSICIAN",
  specialty: "Cardiology",
  organization: "Hosp",
  jobTitle: "Consultant",
  phone: "+971500000000",
  city: "Dubai",
  country: "United Arab Emirates",
  bio: "Bio",
  firstName: "A",
  lastName: "B",
  email: "a@b.com",
};

function req(method: string, body: Record<string, unknown>) {
  return new Request("http://localhost/x", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function words(n: number) {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
}

function coAuthors(n: number) {
  return Array.from({ length: n }, (_, i) => ({ firstName: `F${i}`, lastName: `L${i}` }));
}

function setEventLimits(limits: Record<string, unknown> | undefined) {
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1",
    organizationId: "org1",
    name: "Ev",
    settings: limits ? { abstractLimits: limits } : {},
  });
}

const VALID_CREATE = {
  speakerId: "spk1",
  title: "A short title",
  content: words(50),
  // Required by the schema's superRefine on the SUBMITTED path (pre-existing).
  presentationType: "ORAL" as const,
  status: "SUBMITTED" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.abstractTheme.count.mockResolvedValue(0);
  mockDb.abstractSubTheme.count.mockResolvedValue(0);
  mockAuth.mockResolvedValue(ADMIN);
  setEventLimits(undefined);
  mockDb.speaker.findFirst.mockResolvedValue(COMPLETE_SPEAKER);
  mockDb.abstract.count.mockResolvedValue(0);
  mockDb.abstract.create.mockResolvedValue({ id: "new", status: "SUBMITTED", serialId: 7, speaker: null });
  mockDb.abstract.updateMany.mockResolvedValue({ count: 1 });
  mockDb.abstract.findUniqueOrThrow.mockResolvedValue({
    id: "ab1",
    status: "SUBMITTED",
    speaker: null,
    event: { name: "Ev" },
  });
});

describe("create - format limits", () => {
  it("refuses a title over the event's word limit", async () => {
    setEventLimits({ maxTitleWords: 5 });
    const res = await CREATE(req("POST", { ...VALID_CREATE, title: words(6) }), createParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TITLE_TOO_LONG");
    expect(mockDb.abstract.create).not.toHaveBeenCalled();
  });

  it("accepts a title exactly on the limit", async () => {
    setEventLimits({ maxTitleWords: 5 });
    const res = await CREATE(req("POST", { ...VALID_CREATE, title: words(5) }), createParams);
    expect(res.status).toBeLessThan(400);
  });

  /** The historical 300 must still apply to the estate, which configures nothing. */
  it("applies the default 300-word body limit when the event configures none", async () => {
    const res = await CREATE(req("POST", { ...VALID_CREATE, content: words(301) }), createParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONTENT_TOO_LONG");
  });

  it("honours a raised body limit", async () => {
    setEventLimits({ maxContentWords: 500 });
    const res = await CREATE(req("POST", { ...VALID_CREATE, content: words(400) }), createParams);
    expect(res.status).toBeLessThan(400);
  });

  it("refuses more co-authors than the event allows", async () => {
    setEventLimits({ maxCoAuthors: 3 });
    const res = await CREATE(
      req("POST", { ...VALID_CREATE, coAuthors: coAuthors(4) }),
      createParams,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TOO_MANY_CO_AUTHORS");
  });

  /**
   * Format limits are not completeness gates: a draft with a 60-word title is
   * still a 60-word title. This differs deliberately from the theme and
   * presentation-type rules, which drafts are exempt from.
   */
  it("applies format limits to drafts too", async () => {
    setEventLimits({ maxTitleWords: 5 });
    const res = await CREATE(
      req("POST", { ...VALID_CREATE, status: "DRAFT", title: words(6) }),
      createParams,
    );
    expect(res.status).toBe(400);
  });
});

describe("create - abstracts per submitter", () => {
  beforeEach(() => mockAuth.mockResolvedValue(SUBMITTER));

  it("refuses a submitter already holding the maximum", async () => {
    setEventLimits({ maxAbstractsPerSubmitter: 2 });
    mockDb.abstract.count.mockResolvedValue(2);
    const res = await CREATE(req("POST", VALID_CREATE), createParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("ABSTRACT_LIMIT_REACHED");
    expect(body.meta).toEqual({ held: 2, limit: 2 });
    expect(mockDb.abstract.create).not.toHaveBeenCalled();
  });

  it("admits them at one under the maximum", async () => {
    setEventLimits({ maxAbstractsPerSubmitter: 2 });
    mockDb.abstract.count.mockResolvedValue(1);
    const res = await CREATE(req("POST", VALID_CREATE), createParams);
    expect(res.status).toBeLessThan(400);
  });

  /**
   * The pool rule. Counting the wrong statuses is the difference between "you
   * may have 2 live abstracts" and "you may ever create 2", so the query shape
   * is asserted, not just the outcome.
   */
  it("counts only the review pool, scoped to that speaker and event", async () => {
    setEventLimits({ maxAbstractsPerSubmitter: 2 });
    await CREATE(req("POST", VALID_CREATE), createParams);
    expect(mockDb.abstract.count).toHaveBeenCalledWith({
      where: {
        eventId: "ev1",
        speakerId: "spk1",
        status: { in: ["SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REVISION_REQUESTED"] },
      },
    });
  });

  it("does not count drafts against the cap", async () => {
    setEventLimits({ maxAbstractsPerSubmitter: 1 });
    mockDb.abstract.count.mockResolvedValue(0); // 5 drafts exist; none counted
    const res = await CREATE(req("POST", VALID_CREATE), createParams);
    expect(res.status).toBeLessThan(400);
  });

  it("does not run the count at all when saving a draft", async () => {
    setEventLimits({ maxAbstractsPerSubmitter: 1 });
    const res = await CREATE(req("POST", { ...VALID_CREATE, status: "DRAFT" }), createParams);
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.count).not.toHaveBeenCalled();
  });

  it("does not apply when the event sets no cap", async () => {
    mockDb.abstract.count.mockResolvedValue(99);
    const res = await CREATE(req("POST", VALID_CREATE), createParams);
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.count).not.toHaveBeenCalled();
  });

  /**
   * Staff exemption, matching the deadline and profile gates: an organizer
   * entering an extra abstract on someone's behalf is a deliberate act.
   */
  it("exempts staff creating on a speaker's behalf", async () => {
    mockAuth.mockResolvedValue(ADMIN);
    setEventLimits({ maxAbstractsPerSubmitter: 1 });
    mockDb.abstract.count.mockResolvedValue(5);
    const res = await CREATE(req("POST", VALID_CREATE), createParams);
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.count).not.toHaveBeenCalled();
  });
});

describe("update - grandfathering", () => {
  function existing(overrides: Record<string, unknown> = {}) {
    mockDb.abstract.findFirst.mockResolvedValue({
      id: "ab1",
      eventId: "ev1",
      status: "DRAFT",
      speakerId: "spk1",
      title: words(10),
      content: words(400),
      coAuthors: coAuthors(12),
      presentationType: "ORAL",
      themeId: null,
      subThemeId: null,
      speaker: { ...COMPLETE_SPEAKER, userId: "u1" },
      ...overrides,
    });
  }

  beforeEach(() => existing());

  it("lets an over-cap abstract be saved unchanged", async () => {
    setEventLimits({ maxCoAuthors: 5, maxTitleWords: 3, maxContentWords: 100 });
    const res = await PUT(
      req("PUT", { title: words(10), content: words(400), coAuthors: coAuthors(12) }),
      putParams,
    );
    expect(res.status).toBeLessThan(400);
  });

  it("lets an over-cap value be reduced, even if still over", async () => {
    setEventLimits({ maxCoAuthors: 5 });
    const res = await PUT(req("PUT", { coAuthors: coAuthors(8) }), putParams);
    expect(res.status).toBeLessThan(400);
  });

  it("refuses growing an already over-cap value", async () => {
    setEventLimits({ maxCoAuthors: 5 });
    const res = await PUT(req("PUT", { coAuthors: coAuthors(13) }), putParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TOO_MANY_CO_AUTHORS");
  });

  it("refuses crossing the cap from below", async () => {
    existing({ coAuthors: coAuthors(2) });
    setEventLimits({ maxCoAuthors: 5 });
    const res = await PUT(req("PUT", { coAuthors: coAuthors(6) }), putParams);
    expect(res.status).toBe(400);
  });

  it("refuses a title that grows past a lowered cap", async () => {
    setEventLimits({ maxTitleWords: 3 });
    const res = await PUT(req("PUT", { title: words(11) }), putParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TITLE_TOO_LONG");
  });
});

describe("update - abstracts per submitter on submit", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.abstract.findFirst.mockResolvedValue({
      id: "ab1",
      eventId: "ev1",
      status: "DRAFT",
      speakerId: "spk1",
      title: "T",
      content: words(10),
      coAuthors: [],
      presentationType: "ORAL",
      themeId: null,
      subThemeId: null,
      speaker: { ...COMPLETE_SPEAKER, userId: "u1" },
    });
  });

  it("refuses submitting a draft when the pool is already full", async () => {
    setEventLimits({ maxAbstractsPerSubmitter: 2 });
    mockDb.abstract.count.mockResolvedValue(2);
    const res = await PUT(req("PUT", { status: "SUBMITTED" }), putParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ABSTRACT_LIMIT_REACHED");
    expect(mockDb.abstract.updateMany).not.toHaveBeenCalled();
  });

  /**
   * The abstract being submitted must not count itself. Without the `id: not`
   * clause a cap of 1 would refuse the FIRST submission on a resubmission
   * path, which is the sort of off-by-one that only shows up in production.
   */
  it("excludes the abstract being submitted from its own count", async () => {
    setEventLimits({ maxAbstractsPerSubmitter: 2 });
    await PUT(req("PUT", { status: "SUBMITTED" }), putParams);
    expect(mockDb.abstract.count).toHaveBeenCalledWith({
      where: {
        eventId: "ev1",
        speakerId: "spk1",
        id: { not: "ab1" },
        status: { in: ["SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REVISION_REQUESTED"] },
      },
    });
  });

  it("does not check the cap on an ordinary draft save", async () => {
    setEventLimits({ maxAbstractsPerSubmitter: 1 });
    const res = await PUT(req("PUT", { title: "Edited" }), putParams);
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.count).not.toHaveBeenCalled();
  });
});
