/**
 * Unit tests for the certificate resend route:
 *   POST /api/events/[eventId]/certificates/issued/[certificateId]/resend
 *
 * Surfaces the error code surface, the counter-poisoning guard, and the
 * snapshot-fidelity contract (uses the run row's emailSubject/emailBody
 * when set, falls back to system defaults otherwise).
 *
 * The route's send phase calls into sendEmail() — we mock that to assert
 * the request shape (templateSlug, entityType, attachments) and to
 * exercise the "send failed, don't bump counter" branch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAuth,
  mockDb,
  mockSendEmail,
  mockCheckRateLimit,
  mockResolveCoverEmailTokens,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    issuedCertificate: { findFirst: vi.fn(), update: vi.fn() },
    registration: { findUnique: vi.fn() },
    speaker: { findUnique: vi.fn() },
  },
  mockSendEmail: vi.fn(),
  // No inline implementation — vi.fn's loose signature accepts any
  // args at call sites. Default behavior set in beforeEach.
  mockCheckRateLimit: vi.fn(),
  mockResolveCoverEmailTokens: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    if (role === "REVIEWER" || role === "SUBMITTER" || role === "REGISTRANT") {
      return { status: 403, json: async () => ({ error: "Forbidden" }) };
    }
    return null;
  },
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: (args: unknown) => mockCheckRateLimit(args),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: (args: unknown) => mockSendEmail(args),
  wrapWithBranding: (html: string) => `<wrapped>${html}</wrapped>`,
  inlineCss: (html: string) => html,
  brandingFrom: () => ({ email: "noreply@meetingmindsexperts.com", name: "MMG" }),
}));
vi.mock("@/lib/certificates/email-tokens-resolver", () => ({
  resolveCoverEmailTokens: (tpl: string, ctx: unknown) => mockResolveCoverEmailTokens(tpl, ctx),
}));
vi.mock("@/lib/certificates/email-tokens", () => ({
  SYSTEM_DEFAULT_SUBJECT: "Your {{certificateType}} certificate from {{eventName}}",
  defaultBodyForCategory: (cat: string) => `<p>Hi {{recipientName}}, your ${cat} cert is attached.</p>`,
}));

import { POST } from "@/app/api/events/[eventId]/certificates/issued/[certificateId]/resend/route";

const adminSession = {
  user: { id: "user-1", role: "ADMIN", organizationId: "org-1" },
};
const params = {
  params: Promise.resolve({ eventId: "evt-1", certificateId: "cert-1" }),
};

function makeReq() {
  return new Request("http://test/api/events/evt-1/certificates/issued/cert-1/resend", {
    method: "POST",
  });
}

const baseCert = {
  id: "cert-1",
  eventId: "evt-1",
  type: "ATTENDANCE",
  serial: "ATT-2026-001",
  pdfUrl: "/uploads/certificates/evt-1/cert-1.pdf",
  registrationId: "reg-1",
  speakerId: null,
  revokedAt: null,
  revocationReason: null,
  recipientSnapshot: {
    title: "Dr.",
    firstName: "Jane",
    lastName: "Doe",
    fullName: "Dr. Jane Doe",
  },
  issueRunItem: {
    runId: "run-1",
    run: {
      emailSubject: "Hi {{recipientName}}, your cert is ready",
      emailBody: "<p>Custom body for {{recipientName}}</p>",
    },
  },
  event: {
    id: "evt-1",
    name: "Test Conference",
    startDate: new Date("2026-05-01"),
    endDate: new Date("2026-05-03"),
    venue: null,
    city: null,
    country: null,
    emailHeaderImage: null,
    emailFooterImage: null,
    emailFooterHtml: null,
    emailFromAddress: null,
    emailFromName: null,
    organization: { name: "MMG" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Make loadPdfBytes work via the local-uploads short-circuit. We need
  // fs/promises#readFile to return SOMETHING; mocking the module-level
  // import is awkward because it's a dynamic import inside the route,
  // so for unit tests we instead override the cert's pdfUrl to an
  // empty fetchable URL OR we let the dynamic import fail and assert
  // the 409 PDF_MISSING branch separately. For "happy path" tests
  // below, we use the dynamic-import-mocked approach via test-id setup.
  mockSendEmail.mockResolvedValue({ success: true, messageId: "msg-123" });
  mockCheckRateLimit.mockReturnValue({
    allowed: true,
    remaining: 29,
    retryAfterSeconds: 3600,
  });
  // Pass-through: return whatever template was passed in.
  mockResolveCoverEmailTokens.mockImplementation(
    async (tpl: string) => tpl,
  );
});

describe("POST /api/events/[eventId]/certificates/issued/[certificateId]/resend", () => {
  it("returns 401 when not signed in", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(401);
  });

  it("returns 403 for REVIEWER role", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u2", role: "REVIEWER", organizationId: "org-1" },
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(403);
  });

  it("returns 403 when ADMIN has no organizationId", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u-no-org", role: "ADMIN", organizationId: null },
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(403);
  });

  it("returns 429 with retry-after when rate limit exceeded", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockCheckRateLimit.mockReturnValueOnce({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 1800,
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(429);
    // res.headers in the mocked NextResponse.json is a plain object,
    // not a Web API Headers instance — cast for the property access.
    expect((res.headers as unknown as Record<string, string>)["Retry-After"]).toBe("1800");
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("returns 404 when cert doesn't exist", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(404);
  });

  it("returns 404 on cross-tenant access (non-enumeration)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    // findFirst filters by (id, eventId, event.org) — when cross-tenant
    // it returns null. The route then 404s rather than 403.
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(404);
    // H1 fix: primary query now binds all three of (id, eventId,
    // event.organizationId) atomically.
    const callArgs = mockDb.issuedCertificate.findFirst.mock.calls[0][0];
    expect(callArgs.where.id).toBe("cert-1");
    expect(callArgs.where.eventId).toBe("evt-1");
    expect(callArgs.where.event.organizationId).toBe("org-1");
  });

  it("H1: cross-event-within-same-org returns 404 because of primary-query binding", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    // Operator in org-1 hits the resend endpoint with an eventId from
    // org-1 but pasting a cert id that belongs to a DIFFERENT event in
    // org-1. Prisma's where now filters by both — findFirst returns
    // null even though the cert id + org would match.
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(404);
    // The primary query enforces this; no secondary JS check exists.
    const callArgs = mockDb.issuedCertificate.findFirst.mock.calls[0][0];
    expect(callArgs.where.eventId).toBe("evt-1");
  });

  it("returns 409 CERT_REVOKED when the cert is revoked", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce({
      ...baseCert,
      revokedAt: new Date("2026-05-15"),
      revocationReason: "Withdrew",
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("CERT_REVOKED");
  });

  it("returns 409 PDF_NOT_RENDERED when pdfUrl is null", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce({
      ...baseCert,
      pdfUrl: null,
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("PDF_NOT_RENDERED");
  });

  it("returns 409 when registration has no email on file", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(baseCert);
    mockDb.registration.findUnique.mockResolvedValueOnce({
      attendee: { email: null },
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/no email address/i);
  });

  it("returns 409 PDF_MISSING when loading the PDF throws (cross-machine pattern)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(baseCert);
    mockDb.registration.findUnique.mockResolvedValueOnce({
      attendee: { email: "jane@example.com" },
    });
    // Force loadPdfBytes to throw — the route does a dynamic import of
    // fs/promises, which we can't easily mock in a unit test without
    // setupFiles. Instead, set pdfUrl to a path the local fs will
    // fail on AND not an /uploads/ prefix so it hits the fetch branch
    // with a bogus URL.
    const certWithBadUrl = {
      ...baseCert,
      pdfUrl: "https://does-not-exist.invalid.example/missing.pdf",
    };
    mockDb.issuedCertificate.findFirst.mockReset();
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(certWithBadUrl);
    // Stub global fetch to simulate the network failure path.
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    mockDb.registration.findUnique.mockResolvedValueOnce({
      attendee: { email: "jane@example.com" },
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("PDF_MISSING");
    fetchSpy.mockRestore();
  });

  it("does NOT bump resendCount when SES send fails (counter-poisoning guard)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    // Bypass the disk read by routing to a fetchable URL we'll mock.
    const certHttp = {
      ...baseCert,
      pdfUrl: "https://test-bucket.supabase.co/storage/v1/object/public/cert-1.pdf",
    };
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(certHttp);
    mockDb.registration.findUnique.mockResolvedValueOnce({
      attendee: { email: "jane@example.com" },
    });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }),
    );
    mockSendEmail.mockResolvedValueOnce({
      success: false,
      error: "SES throttling exceeded",
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("SEND_FAILED");
    // CRITICAL: counter was NOT bumped.
    expect(mockDb.issuedCertificate.update).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("happy path: bumps resendCount + lastResentAt AFTER successful send, uses run snapshot, threads templateSlug", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    const certHttp = {
      ...baseCert,
      pdfUrl: "https://test-bucket.supabase.co/storage/v1/object/public/cert-1.pdf",
    };
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(certHttp);
    mockDb.registration.findUnique.mockResolvedValueOnce({
      attendee: { email: "jane@example.com" },
    });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }),
    );
    mockSendEmail.mockResolvedValueOnce({
      success: true,
      messageId: "msg-abc",
    });
    mockDb.issuedCertificate.update.mockResolvedValueOnce({
      resendCount: 1,
      lastResentAt: new Date("2026-06-03T12:00:00Z"),
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    // Asserts that the cover-email snapshot from the run row was used,
    // not the system default (replay fidelity).
    const resolverCalls = mockResolveCoverEmailTokens.mock.calls;
    const subjectTpl = resolverCalls[0][0] as string;
    expect(subjectTpl).toContain("your cert is ready");
    const bodyTpl = resolverCalls[1][0] as string;
    expect(bodyTpl).toContain("Custom body");

    // Asserts templateSlug discriminator threaded for EmailLogCard pill.
    const sendArgs = mockSendEmail.mock.calls[0][0] as {
      emailType?: string;
      logContext?: { templateSlug?: string; entityType?: string; entityId?: string };
      attachments?: Array<{ name?: string; contentType?: string }>;
      to?: Array<{ email?: string; name?: string }>;
    };
    expect(sendArgs.emailType).toBe("certificate");
    expect(sendArgs.logContext?.templateSlug).toBe("certificate-delivery");
    expect(sendArgs.logContext?.entityType).toBe("REGISTRATION");
    expect(sendArgs.logContext?.entityId).toBe("reg-1");
    expect(sendArgs.attachments?.[0].name).toBe("ATT-2026-001.pdf");
    expect(sendArgs.attachments?.[0].contentType).toBe("application/pdf");
    expect(sendArgs.to?.[0].email).toBe("jane@example.com");
    expect(sendArgs.to?.[0].name).toBe("Dr. Jane Doe");

    // Counter bumped via Prisma increment (atomic).
    const updateArgs = mockDb.issuedCertificate.update.mock.calls[0][0] as {
      data: { resendCount: { increment: number }; lastResentAt: Date };
    };
    expect(updateArgs.data.resendCount).toEqual({ increment: 1 });
    expect(updateArgs.data.lastResentAt).toBeInstanceOf(Date);

    fetchSpy.mockRestore();
  });

  it("falls back to system defaults when run snapshot is missing (legacy cert)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    const certNoRun = {
      ...baseCert,
      pdfUrl: "https://test-bucket.supabase.co/storage/v1/object/public/cert-1.pdf",
      issueRunItem: null, // pre-cover-email-editor cert
    };
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(certNoRun);
    mockDb.registration.findUnique.mockResolvedValueOnce({
      attendee: { email: "jane@example.com" },
    });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }),
    );
    mockDb.issuedCertificate.update.mockResolvedValueOnce({
      resendCount: 1,
      lastResentAt: new Date(),
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const subjectTpl = mockResolveCoverEmailTokens.mock.calls[0][0] as string;
    expect(subjectTpl).toContain("{{certificateType}}");
    const bodyTpl = mockResolveCoverEmailTokens.mock.calls[1][0] as string;
    expect(bodyTpl).toContain("ATTENDANCE");

    fetchSpy.mockRestore();
  });

  it("H2: rejects pdfUrl that escapes /public/uploads/certificates/", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    // Operator-controlled pdfUrl can't actually do this today (pdfUrl
    // is system-generated). But the defense-in-depth fix ensures any
    // future surface that mutates pdfUrl can't break out.
    const traversalCert = {
      ...baseCert,
      pdfUrl: "/uploads/../../etc/passwd",
    };
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(traversalCert);
    mockDb.registration.findUnique.mockResolvedValueOnce({
      attendee: { email: "jane@example.com" },
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("PDF_MISSING");
  });

  it("H2: rejects pdfUrl pointing at /uploads/photos/ (outside certificates/)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    const wrongDirCert = {
      ...baseCert,
      pdfUrl: "/uploads/photos/some-photo.jpg",
    };
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(wrongDirCert);
    mockDb.registration.findUnique.mockResolvedValueOnce({
      attendee: { email: "jane@example.com" },
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("PDF_MISSING");
  });

  it("H2: rejects remote pdfUrl on hosts not in the SSRF allowlist", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    const ssrfCert = {
      ...baseCert,
      pdfUrl: "https://evil.example.com/cert.pdf",
    };
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(ssrfCert);
    mockDb.registration.findUnique.mockResolvedValueOnce({
      attendee: { email: "jane@example.com" },
    });
    // Crucially: fetch should NOT be called for blocked hosts.
    const fetchSpy = vi.spyOn(global, "fetch");

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("PDF_MISSING");
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("H2: rejects http:// remote pdfUrl (must be https)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    const httpCert = {
      ...baseCert,
      pdfUrl: "http://my-bucket.supabase.co/cert.pdf", // plaintext, even on allowed host
    };
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(httpCert);
    mockDb.registration.findUnique.mockResolvedValueOnce({
      attendee: { email: "jane@example.com" },
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("PDF_MISSING");
  });

  it("H2: allows remote pdfUrl on *.supabase.co with https", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    const supabaseCert = {
      ...baseCert,
      pdfUrl: "https://my-bucket.supabase.co/storage/v1/object/public/certificates/cert.pdf",
    };
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(supabaseCert);
    mockDb.registration.findUnique.mockResolvedValueOnce({
      attendee: { email: "jane@example.com" },
    });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }),
    );
    mockDb.issuedCertificate.update.mockResolvedValueOnce({
      resendCount: 1,
      lastResentAt: new Date(),
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();

    fetchSpy.mockRestore();
  });

  it("speaker path: queries speaker.email + sets entityType=SPEAKER", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    const speakerCert = {
      ...baseCert,
      type: "APPRECIATION",
      registrationId: null,
      speakerId: "spk-1",
      pdfUrl: "https://test-bucket.supabase.co/storage/v1/object/public/cert-1.pdf",
    };
    mockDb.issuedCertificate.findFirst.mockResolvedValueOnce(speakerCert);
    mockDb.speaker.findUnique.mockResolvedValueOnce({
      email: "speaker@example.com",
    });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }),
    );
    mockDb.issuedCertificate.update.mockResolvedValueOnce({
      resendCount: 1,
      lastResentAt: new Date(),
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    expect(mockDb.speaker.findUnique).toHaveBeenCalledWith({
      where: { id: "spk-1" },
      select: { email: true },
    });
    expect(mockDb.registration.findUnique).not.toHaveBeenCalled();
    const sendArgs = mockSendEmail.mock.calls[0][0] as {
      logContext?: { entityType?: string; entityId?: string };
    };
    expect(sendArgs.logContext?.entityType).toBe("SPEAKER");
    expect(sendArgs.logContext?.entityId).toBe("spk-1");

    fetchSpy.mockRestore();
  });
});
