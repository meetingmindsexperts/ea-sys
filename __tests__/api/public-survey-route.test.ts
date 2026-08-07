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
    },
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
    expect((await res.json()).alreadyCompleted).toBe(true);
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

// ── Shareable link: "email me my survey link" (review B1) ──────────────
//
// The share link is BROADCAST (QR on a closing slide, WhatsApp), so it
// carries no per-person identity. It used to accept the respondent's
// identity as a TYPED EMAIL and submit on that basis, stamping
// Registration.surveyCompletedAt — which certificates/auto-issue.ts polls
// to mint a real CME certificate. A stranger who knew an attendee's email
// could therefore issue a certificate in their name AND permanently lock
// the real attendee out (SurveyResponse.registrationId is @unique).
//
// These tests pin the fix: the share path now only EMAILS the person their
// per-registration token, and its HTTP response never varies with whether
// the address is registered.
describe("POST share link — request my survey link", () => {
  const SHARE_TOKEN = "share-token-abc";

  function shareEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: "evt-1",
      name: "OSH Monthly Meeting",
      slug: SLUG,
      organizationId: "org-1",
      surveyShareLink: {
        token: SHARE_TOKEN,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
        createdByUserId: "user-1",
      },
      surveyConfig: SAMPLE_CONFIG,
      organization: { name: "MeetingMinds" },
      ...overrides,
    };
  }

  function shareRegistration(overrides: Record<string, unknown> = {}) {
    return {
      id: "reg-1",
      surveyCompletedAt: null,
      attendeeId: "att-1",
      attendee: { id: "att-1", firstName: "Sara", email: "sara@hospital.com", tags: [] },
      event: { id: "evt-1", name: "OSH Monthly Meeting", slug: SLUG },
      ...overrides,
    };
  }

  beforeEach(async () => {
    const { getEventTemplate } = await import("@/lib/email");
    vi.mocked(getEventTemplate).mockResolvedValue({
      subject: "How was {{eventName}}?",
      htmlContent: "<p>Dear {{firstName}},</p><a href=\"{{surveyLink}}\">Take the survey</a>",
      textContent: "Dear {{firstName}}, {{surveyLink}}",
      branding: {},
    } as never);
  });

  it("NEVER stamps surveyCompletedAt or writes a SurveyResponse — even if answers are supplied (the B1 exploit shape)", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce(shareEvent());
    mockDb.registration.findMany.mockResolvedValueOnce([shareRegistration()]);

    const res = await POST(
      makePostReq({
        share: SHARE_TOKEN,
        email: "sara@hospital.com",
        // The old handler accepted these and submitted the survey.
        answers: { q1: 5, q2: "Academia" },
      }),
      PARAMS,
    );

    expect(res.status).toBe(200);
    // The credential-issuing flag is never touched, and no response row is
    // created — so certificate auto-issue can never fire off this path.
    expect(mockDb.registration.update).not.toHaveBeenCalled();
    expect(mockDb.surveyResponse.create).not.toHaveBeenCalled();
  });

  it("mints a per-registration token (dropping any previous one) and emails the link", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce(shareEvent());
    mockDb.registration.findMany.mockResolvedValueOnce([shareRegistration()]);

    const res = await POST(
      makePostReq({ share: SHARE_TOKEN, email: "sara@hospital.com" }),
      PARAMS,
    );
    expect(res.status).toBe(200);

    // Exactly one live link per registration — old ones dropped first.
    expect(mockDb.verificationToken.deleteMany).toHaveBeenCalledWith({
      where: { identifier: "survey:reg-1" },
    });
    const created = mockDb.verificationToken.create.mock.calls[0]![0] as {
      data: { identifier: string; token: string; expires: Date };
    };
    expect(created.data.identifier).toBe("survey:reg-1");
    // Stored HASHED — the raw secret only ever exists in the email.
    expect(created.data.token).toMatch(/^hashed:/);
    expect(created.data.expires.getTime()).toBeGreaterThan(Date.now());

    // Emailed to the typed address, carrying a ?token= link (not ?share=).
    const sendArgs = mockSendEmail.mock.calls[0]![0] as {
      to: { email: string }[];
      htmlContent: string;
    };
    expect(sendArgs.to).toEqual([{ email: "sara@hospital.com" }]);
    expect(sendArgs.htmlContent).toContain("/survey?token=");
    expect(sendArgs.htmlContent).not.toContain("share=");
  });

  it("is NOT an enumeration oracle — an unregistered email gets the identical 200 body, and no email is sent", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce(shareEvent());
    mockDb.registration.findMany.mockResolvedValueOnce([shareRegistration()]);
    const registered = await POST(
      makePostReq({ share: SHARE_TOKEN, email: "sara@hospital.com" }),
      PARAMS,
    );
    const registeredBody = await registered.json();

    vi.clearAllMocks();
    const { getEventTemplate } = await import("@/lib/email");
    vi.mocked(getEventTemplate).mockResolvedValue({
      subject: "s", htmlContent: "h", textContent: "t", branding: {},
    } as never);
    mockDb.event.findFirst.mockResolvedValueOnce(shareEvent());
    mockDb.registration.findMany.mockResolvedValueOnce([]); // not registered
    const unknown = await POST(
      makePostReq({ share: SHARE_TOKEN, email: "stranger@evil.com" }),
      PARAMS,
    );
    const unknownBody = await unknown.json();

    expect(unknown.status).toBe(registered.status);
    expect(unknownBody).toEqual(registeredBody);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("still sends a link when the survey was already completed (uniform response; the token page explains)", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce(shareEvent());
    mockDb.registration.findMany.mockResolvedValueOnce([
      shareRegistration({ surveyCompletedAt: new Date() }),
    ]);

    const res = await POST(
      makePostReq({ share: SHARE_TOKEN, email: "sara@hospital.com" }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalled();
    expect(mockDb.registration.update).not.toHaveBeenCalled();
  });

  it("rejects an invalid share token", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce(shareEvent());
    const res = await POST(
      makePostReq({ share: "wrong-token", email: "sara@hospital.com" }),
      PARAMS,
    );
    expect(res.status).toBe(400);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("rejects an expired share token", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce(
      shareEvent({
        surveyShareLink: {
          token: SHARE_TOKEN,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          createdAt: new Date().toISOString(),
          createdByUserId: "user-1",
        },
      }),
    );
    const res = await POST(
      makePostReq({ share: SHARE_TOKEN, email: "sara@hospital.com" }),
      PARAMS,
    );
    expect(res.status).toBe(400);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("is NOT gated by the submit rate limit — a whole hall scans the QR from ONE venue-NAT IP (regression guard)", async () => {
    // The submit limit is 10/15min/IP, calibrated for "one submit per person".
    // The share path is the QR entry point for a ROOM, so it must be
    // dispatched before that limit and use its own room-scale one. If this
    // ordering regresses, attendee #11 onwards silently cannot get a link.
    mockDb.event.findFirst.mockResolvedValueOnce(shareEvent());
    mockDb.registration.findMany.mockResolvedValueOnce([shareRegistration()]);
    // Only ONE checkRateLimit call should happen before the work: the share
    // path's own per-IP. (Then the per-email one.)
    const res = await POST(
      makePostReq({ share: SHARE_TOKEN, email: "sara@hospital.com" }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    // Exactly two limit checks — share per-IP + per-email. A third would mean
    // the submit limit is once again in front of the share path.
    expect(mockRateLimit).toHaveBeenCalledTimes(2);
    expect(mockSendEmail).toHaveBeenCalled();
  });

  it("per-email rate limit returns the SAME generic 200 (a 429 would re-open the oracle) and sends nothing", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce(shareEvent());
    // First call = the per-IP check (allowed), second = per-email (blocked).
    mockRateLimit
      .mockReturnValueOnce({ allowed: true, retryAfterSeconds: 0 })
      .mockReturnValueOnce({ allowed: false, retryAfterSeconds: 900 });

    const res = await POST(
      makePostReq({ share: SHARE_TOKEN, email: "sara@hospital.com" }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockDb.verificationToken.create).not.toHaveBeenCalled();
  });
});
