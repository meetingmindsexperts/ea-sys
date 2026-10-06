/**
 * Unit tests for the public survey route:
 *   GET  /api/public/events/[slug]/survey  — validate token + return config
 *   POST /api/public/events/[slug]/survey  — submit + side-effect chain
 *
 * Covers every named branch from the plan §"Public survey submit" +
 * the failure-logging contract. If any of these assertions break, the
 * downstream cert-gating flow ("filter by survey-completed tag") also
 * breaks — these are load-bearing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockRateLimit, mockSendEmail, mockHashToken } = vi.hoisted(() => ({
  mockDb: {
    verificationToken: {
      findUnique: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
      // Share "email me my link" path mints exactly like bulk-email does.
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
    },
    registration: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    attendee: {
      update: vi.fn(),
    },
    surveyResponse: {
      create: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    // The event's certificate survey (Oct 6, 2026). Null by default: the
    // route then falls back to the old Event columns, the shape every test
    // below was written against.
    survey: {
      findFirst: vi.fn().mockResolvedValue(null),
      // A CME answer with no Survey row creates the reserved row first.
      create: vi.fn().mockResolvedValue({ id: "svy-made" }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    event: {
      findFirst: vi.fn(),
    },
    // resolveTenantOrg() consults this; null → legacy unscoped behavior.
    tenantDomain: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn(),
  },
  mockRateLimit: vi.fn((): { allowed: boolean; retryAfterSeconds: number } => ({
    allowed: true,
    retryAfterSeconds: 0,
  })),
  mockSendEmail: vi.fn().mockResolvedValue({ success: true, messageId: "stub" }),
  mockHashToken: vi.fn((t: string) => `hashed:${t}`),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> },
    ) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(Object.entries(init?.headers ?? {})),
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
  // tenantTransaction with the flag off IS db.$transaction — delegate so the
  // test's tx interception keeps working for the migrated sites.
  tenantTransaction: (fn: (tx: unknown) => unknown) => mockDb.$transaction(fn),
}));

vi.mock("@/lib/security", () => ({
  getClientIp: () => "127.0.0.1",
  checkRateLimit: () => mockRateLimit(),
  hashVerificationToken: (t: string) => mockHashToken(t),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
  // The route fetches the per-event template override (returns null
  // here so the route falls back to the default) and renders via
  // renderAndWrap. Stub all three so the route never reaches an
  // unmocked import. Render returns the template body verbatim with
  // {{firstName}} / {{eventName}} substituted — close enough to
  // exercise the per-recipient send call shape.
  loadActiveEventTemplateRow: vi.fn(),
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({
    slug: "survey-thankyou",
    name: "Survey Thank You",
    subject: "Thank you for your feedback — {{eventName}}",
    htmlContent: "<p>Dear {{firstName}},</p>",
    textContent: "Dear {{firstName}},",
  }),
  renderAndWrap: vi.fn((tpl: { subject: string; htmlContent: string; textContent: string }, vars: Record<string, string | number | undefined>) => {
    const sub = (str: string) =>
      str.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ""));
    return {
      subject: sub(tpl.subject),
      htmlContent: sub(tpl.htmlContent),
      textContent: sub(tpl.textContent),
    };
  }),
  brandingFrom: vi.fn(() => undefined),
  brandingCc: vi.fn(() => undefined),
}));

// Mock the Prisma namespace so the route's `instanceof
// Prisma.PrismaClientKnownRequestError` + `Prisma.JsonNull` /
// `Prisma.InputJsonValue` references resolve in the test environment
// without spinning up the full client.
vi.mock("@prisma/client", () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    clientVersion = "6.0.0";
    meta: Record<string, unknown> | undefined;
    constructor(message: string, opts: { code: string; meta?: Record<string, unknown> }) {
      super(message);
      this.code = opts.code;
      this.meta = opts.meta;
    }
  }
  return {
    Prisma: {
      PrismaClientKnownRequestError,
      JsonNull: { __prisma: "JsonNull" },
    },
  };
});

import { GET, POST } from "@/app/api/public/events/[slug]/survey/route";
import { Prisma } from "@prisma/client";

const SLUG = "evt-2026";
const PARAMS = { params: Promise.resolve({ slug: SLUG }) };

const SAMPLE_CONFIG = [
  { id: "q1", type: "rating_1_to_5", label: "Overall", required: true },
  {
    id: "q2",
    type: "single_select",
    label: "Role",
    required: true,
    options: ["Academia", "Physician"],
  },
  { id: "q3", type: "text", label: "Comments", required: false },
];

function makeGetReq(token?: string) {
  const url = token
    ? `http://localhost/api/public/events/${SLUG}/survey?token=${token}`
    : `http://localhost/api/public/events/${SLUG}/survey`;
  return new Request(url);
}

function makePostReq(body: unknown) {
  return new Request(`http://localhost/api/public/events/${SLUG}/survey`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function baseTokenRow(overrides: Record<string, unknown> = {}) {
  return {
    identifier: "survey:reg-1",
    token: "hashed:raw",
    expires: new Date(Date.now() + 1000 * 60 * 60 * 24),
    ...overrides,
  };
}

function baseRegistration(overrides: Record<string, unknown> = {}) {
  return {
    id: "reg-1",
    surveyCompletedAt: null,
    attendeeId: "att-1",
    attendee: {
      id: "att-1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      title: "DR",
      tags: ["checked-in"],
    },
    event: {
      id: "evt-1",
      name: "Conf 2026",
      slug: SLUG,
      bannerImage: null,
      surveyConfig: SAMPLE_CONFIG,
      emailHeaderImage: null,
      emailFooterImage: null,
      emailFooterHtml: null,
      emailFromAddress: null,
      emailFromName: null,
      emailCcAddresses: [],
      organizationId: "org-1",
      bannerImageMobile: null,
      surveyIntroHtml: "<p>Intro</p>",
      surveyThankYouHtml: "<p>Thanks from the organizing committee</p>",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  // Transaction passthrough so route's `db.$transaction(async tx => ...)`
  // works against the same mock surface as outside the tx.
  mockDb.$transaction.mockImplementation(
    async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb),
  );
  mockSendEmail.mockResolvedValue({ success: true, messageId: "stub" });
});

// ── GET branches ────────────────────────────────────────────────────────

describe("GET /api/public/events/[slug]/survey", () => {
  it("returns 400 when token query param is missing", async () => {
    const res = await GET(makeGetReq(), PARAMS);
    expect(res.status).toBe(400);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 3600 });
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
  });

  it("returns 400 when token is not in the DB", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(null);
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(400);
  });

  it("returns 400 and deletes token when expired", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(
      baseTokenRow({ expires: new Date(Date.now() - 1000) }),
    );
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(400);
    expect(mockDb.verificationToken.delete).toHaveBeenCalledWith({
      where: { token: "hashed:raw" },
    });
  });

  it("returns 400 when token has wrong prefix (defence against reusing a different-domain token)", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(
      baseTokenRow({ identifier: "reg:reg-1" }),
    );
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(400);
  });

  it("returns 404 when registration is not found", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(null);
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(404);
  });

  it("returns 400 when slug in URL doesn't match the token's event", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(
      baseRegistration({
        event: { ...baseRegistration().event, slug: "other-slug" },
      }),
    );
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the event has no survey configured", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(
      baseRegistration({
        event: { ...baseRegistration().event, surveyConfig: null },
      }),
    );
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(404);
  });

  it("returns alreadyCompleted=true when the registration has already submitted", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(
      baseRegistration({ surveyCompletedAt: new Date() }),
    );
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyCompleted).toBe(true);
    // A later invitation opened after answering shows the organizer's thank-you, not the form.
    expect(body.thankYouHtml).toBe("<p>Thanks from the organizing committee</p>");
  });

  it("returns config + read-only identity prefill on the happy path", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyCompleted).toBe(false);
    expect(body.config).toEqual(SAMPLE_CONFIG);
    expect(body.attendee.email).toBe("jane@example.com");
    expect(body.attendee.firstName).toBe("Jane");
    // Both organizer messages travel with the form, so the page can show the
    // thank-you the moment the submit succeeds without another request.
    expect(body.introHtml).toBe("<p>Intro</p>");
    expect(body.thankYouHtml).toBe("<p>Thanks from the organizing committee</p>");
  });
});

// ── POST branches ───────────────────────────────────────────────────────

describe("POST /api/public/events/[slug]/survey", () => {
  it("returns 429 when rate limited", async () => {
    mockRateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 60 });
    const res = await POST(
      makePostReq({ token: "raw", answers: {} }),
      PARAMS,
    );
    expect(res.status).toBe(429);
  });

  it("returns 400 when body is malformed (missing token)", async () => {
    const res = await POST(makePostReq({ answers: {} }), PARAMS);
    expect(res.status).toBe(400);
  });

  it("returns 400 when answers are missing required questions", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());
    const res = await POST(
      makePostReq({ token: "raw", answers: { q3: "comment" } }), // q1 + q2 required, missing
      PARAMS,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("returns 400 when a rating answer is out of range (server defends against DOM tampering)", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());
    const res = await POST(
      makePostReq({ token: "raw", answers: { q1: 99, q2: "Academia" } }),
      PARAMS,
    );
    expect(res.status).toBe(400);
  });

  it("happy path: persists response + sets surveyCompletedAt + adds tag + deletes token + DEFERS thank-you (no inline send)", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());

    const res = await POST(
      makePostReq({
        token: "raw",
        answers: { q1: 5, q2: "Academia", q3: "Great!" },
      }),
      PARAMS,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(mockDb.surveyResponse.create).toHaveBeenCalledTimes(1);
    expect(mockDb.surveyResponse.create.mock.calls[0][0].data.answers).toEqual({
      q1: 5,
      q2: "Academia",
      q3: "Great!",
    });
    // Tenancy (Domain #16 review): the response ROW must stamp the event's
    // org — a refactor dropping the stamp would mint org-NULL rows that are
    // invisible under platform RLS while the suite stays green (the
    // certificates-review L6 lesson, carried forward).
    expect(mockDb.surveyResponse.create.mock.calls[0][0].data.organizationId).toBe("org-1");
    expect(mockDb.registration.update).toHaveBeenCalledWith({
      where: { id: "reg-1" },
      data: { surveyCompletedAt: expect.any(Date) },
    });
    // Tag merge preserves "checked-in" + adds "survey-completed" (no
    // duplicate even if the tag was already there).
    expect(mockDb.attendee.update).toHaveBeenCalledWith({
      where: { id: "att-1" },
      data: { tags: ["checked-in", "survey-completed"] },
    });
    expect(mockDb.verificationToken.delete).toHaveBeenCalled();
    // Thank-you is NOT sent inline anymore — it's deferred to the cert-issue
    // worker's survey-thankyou sweep so the certificate PDF can be attached.
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("idempotent: second submit returns ok=true alreadyCompleted=true without re-firing thank-you", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(
      baseRegistration({ surveyCompletedAt: new Date() }),
    );

    const res = await POST(
      makePostReq({
        token: "raw",
        answers: { q1: 4, q2: "Physician" },
      }),
      PARAMS,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alreadyCompleted).toBe(true);
    expect(mockDb.surveyResponse.create).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("race-dedup: P2002 inside the transaction returns 200 alreadyCompleted=true (no rethrow, no thank-you)", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());
    // Force the transaction to throw P2002 on the SurveyResponse.create.
    mockDb.$transaction.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "6.0.0",
      });
    });

    const res = await POST(
      makePostReq({
        token: "raw",
        answers: { q1: 5, q2: "Academia" },
      }),
      PARAMS,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyCompleted).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("returns 500 (not silent) when transaction fails with a non-P2002 error", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());
    mockDb.$transaction.mockImplementationOnce(async () => {
      throw new Error("db down");
    });

    const res = await POST(
      makePostReq({
        token: "raw",
        answers: { q1: 5, q2: "Academia" },
      }),
      PARAMS,
    );
    expect(res.status).toBe(500);
  });

  it("survey submit defers the thank-you — never sends email inline", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());

    const res = await POST(
      makePostReq({
        token: "raw",
        answers: { q1: 5, q2: "Academia" },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    // The deferred sweep (worker) owns delivery; the submit path sends nothing.
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("returns 404 when registration is missing", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(null);
    const res = await POST(
      makePostReq({ token: "raw", answers: { q1: 5, q2: "Academia" } }),
      PARAMS,
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when slug in URL doesn't match token's event", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(
      baseRegistration({
        event: { ...baseRegistration().event, slug: "other-slug" },
      }),
    );
    const res = await POST(
      makePostReq({ token: "raw", answers: { q1: 5, q2: "Academia" } }),
      PARAMS,
    );
    expect(res.status).toBe(400);
  });
});

// ── Retired shareable link (Sep 17, 2026) ─────────────────────────────
//
// Surveys are reached ONLY through the personal `?token=` link in the Survey
// Invitation email. The shareable `?share=` link is retired: a printed QR or a
// forwarded message still arrives here, so both verbs answer 410 with a message
// pointing at the personal email, and neither touches the database, mints a
// token, sends an email or stamps surveyCompletedAt (which issues a CME
// certificate). The email it used to send was failing in production on the
// unresolved-token guard, which is how the retirement started.
describe("retired shareable link", () => {
  function makeShareGetReq(share: string) {
    return new Request(`http://localhost/api/public/events/${SLUG}/survey?share=${share}`);
  }

  it("GET ?share= answers 410 with the personal-link message and reads nothing", async () => {
    const res = await GET(makeShareGetReq("share-token-abc"), PARAMS);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toMatch(/personal survey link/i);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    expect(mockDb.verificationToken.findUnique).not.toHaveBeenCalled();
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("POST { share, email, answers } answers 410 and has no side effect at all", async () => {
    const res = await POST(
      makePostReq({
        share: "share-token-abc",
        email: "sara@hospital.com",
        answers: { q1: "5", q2: "Physician" },
      }),
      PARAMS,
    );
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/personal survey link/i);

    expect(mockDb.surveyResponse.create).not.toHaveBeenCalled();
    expect(mockDb.registration.update).not.toHaveBeenCalled();
    expect(mockDb.verificationToken.create).not.toHaveBeenCalled();
    expect(mockDb.verificationToken.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("is refused before the submit rate limit, so an old QR cannot spend a room's budget", async () => {
    await POST(makePostReq({ share: "share-token-abc", email: "sara@hospital.com" }), PARAMS);
    expect(mockRateLimit).not.toHaveBeenCalled();
  });
});

describe("the personal link opens the event's certificate survey (multi-survey step 2, Oct 6, 2026)", () => {
  const CERT = {
    id: "svy-cert",
    eventId: "evt-1",
    name: "Post-event survey",
    config: SAMPLE_CONFIG,
    introHtml: "<p>Survey-table intro</p>",
    thankYouHtml: "<p>Survey-table thanks</p>",
    isActive: true,
    sortOrder: 0,
    gatesCertificates: true,
    responseMode: "ONCE",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  it("GET serves the CME survey's content exactly as before (the Event columns), even if the Survey row differs", async () => {
    // A Survey row left stale by an edit on the old screens during a deploy
    // must never change what the personal link shows.
    mockDb.survey.findFirst.mockResolvedValueOnce({ ...CERT, introHtml: "<p>stale row intro</p>", thankYouHtml: "<p>stale row thanks</p>" });
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.introHtml).toBe("<p>Intro</p>");
    expect(body.thankYouHtml).toBe("<p>Thanks from the organizing committee</p>");
  });

  it("POST writes the response against the certificate survey and still marks completion", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce(CERT);
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());
    const res = await POST(makePostReq({ token: "raw", answers: { q1: 5, q2: "Academia", q3: "Great!" } }), PARAMS);
    expect(res.status).toBe(200);
    const data = mockDb.surveyResponse.create.mock.calls[0][0].data;
    expect(data.surveyId).toBe("svy-cert");
    expect(data.dedupKey).toBe("reg-1");
    expect(mockDb.registration.update).toHaveBeenCalledWith({ where: { id: "reg-1" }, data: { surveyCompletedAt: expect.any(Date) } });
  });

  it("a cleared or closed CME survey (Event columns null) reads as no survey (404), as before", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow());
    mockDb.registration.findFirst.mockResolvedValueOnce(
      baseRegistration({ event: { ...baseRegistration().event, surveyConfig: null } }),
    );
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(404);
  });
});

describe("links that name their survey (step 3, Oct 6, 2026)", () => {
  // clearAllMocks keeps queued one-off values; reset these so a value an
  // earlier test queued but never consumed cannot leak in.
  beforeEach(() => {
    mockDb.survey.findFirst.mockReset().mockResolvedValue(null);
    mockDb.surveyResponse.count.mockReset().mockResolvedValue(0);
  });
  const FB = {
    id: "svy-fb", eventId: "evt-1", name: "Webinar feedback",
    config: [{ id: "f1", type: "rating_1_to_5", label: "Useful?", required: true }],
    introHtml: "<p>Feedback intro</p>", thankYouHtml: "<p>Thanks for the feedback</p>",
    isActive: true, sortOrder: 1, gatesCertificates: false, responseMode: "ONCE",
    createdAt: new Date(0), updatedAt: new Date(0),
  };
  const CERT_ROW = { ...FB, id: "svy-cert", name: "Post-event survey", gatesCertificates: true, sortOrder: 0 };

  it("an extra-survey link opens that survey, even after the person finished their CME survey", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow({ identifier: "survey:svy-fb:reg-1" }));
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration({ surveyCompletedAt: new Date() }));
    mockDb.survey.findFirst.mockResolvedValueOnce(FB);
    mockDb.surveyResponse.count.mockResolvedValueOnce(0);
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyCompleted).toBe(false);
    expect(body.introHtml).toBe("<p>Feedback intro</p>");
  });

  it("submitting an extra survey records it against that survey and NEVER marks CME completion", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow({ identifier: "survey:svy-fb:reg-1" }));
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());
    mockDb.survey.findFirst.mockResolvedValueOnce(FB);
    mockDb.surveyResponse.count.mockResolvedValueOnce(0);
    const res = await POST(makePostReq({ token: "raw", answers: { f1: 4 } }), PARAMS);
    expect(res.status).toBe(200);
    expect(mockDb.surveyResponse.create.mock.calls[0][0].data).toMatchObject({ surveyId: "svy-fb", dedupKey: "reg-1" });
    expect(mockDb.registration.update).not.toHaveBeenCalled();
    expect(mockDb.attendee.update).not.toHaveBeenCalled();
    expect(mockDb.verificationToken.delete).toHaveBeenCalled();
  });

  it("a closed extra survey says so (410) instead of 'invalid link'", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow({ identifier: "survey:svy-fb:reg-1" }));
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());
    mockDb.survey.findFirst.mockResolvedValueOnce({ ...FB, isActive: false });
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/closed/);
  });

  it("a link naming the CME survey behaves exactly like an old link (Event columns, completion marked)", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow({ identifier: "survey:svy-cert:reg-1" }));
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());
    mockDb.survey.findFirst.mockResolvedValueOnce(CERT_ROW).mockResolvedValueOnce(CERT_ROW);
    const res = await POST(makePostReq({ token: "raw", answers: { q1: 5, q2: "Academia", q3: "Great!" } }), PARAMS);
    expect(res.status).toBe(200);
    expect(mockDb.surveyResponse.create.mock.calls[0][0].data.surveyId).toBe("svy-cert");
    expect(mockDb.registration.update).toHaveBeenCalledWith({ where: { id: "reg-1" }, data: { surveyCompletedAt: expect.any(Date) } });
  });

  it("a link naming another event's survey opens nothing (404)", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValueOnce(baseTokenRow({ identifier: "survey:svy-other:reg-1" }));
    mockDb.registration.findFirst.mockResolvedValueOnce(baseRegistration());
    mockDb.survey.findFirst.mockResolvedValueOnce(null);
    const res = await GET(makeGetReq("raw"), PARAMS);
    expect(res.status).toBe(404);
  });
});

