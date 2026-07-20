/**
 * Public speaker-reimbursement routes:
 *   - submit happy path uses a CONDITIONAL claim (updateMany on
 *     status=PENDING) so a double-submit race commits exactly once
 *   - SUBMITTED forms are locked (409), invalid tokens 404
 *   - the paper form's receipt rule is enforced server-side
 *     (MISSING_DOCUMENTS names the uncovered kinds)
 *   - the public /uploads catch-all BLOCKS the reimbursements/ prefix
 *     (passport scans + receipts must only stream via the authed route)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockRateLimit, mockNotify, mockSendEmail, mockGetEventTemplate } = vi.hoisted(() => ({
  mockDb: {
    speakerReimbursement: { findUnique: vi.fn(), updateMany: vi.fn() },
    speakerReimbursementDocument: { findFirst: vi.fn(), delete: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  mockNotify: vi.fn().mockResolvedValue(undefined),
  mockSendEmail: vi.fn().mockResolvedValue(undefined),
  mockGetEventTemplate: vi.fn().mockResolvedValue({
    subject: "s",
    htmlContent: "<p>{{claimSummary}}</p>",
    textContent: "{{claimSummaryText}}",
    branding: {},
  }),
}));

vi.mock("next/server", () => {
  class MockNextResponse {
    status: number;
    body: unknown;
    constructor(body: unknown, init?: { status?: number }) {
      this.body = body;
      this.status = init?.status ?? 200;
    }
    static json(body: unknown, init?: { status?: number }) {
      return { status: init?.status ?? 200, json: async () => body };
    }
  }
  return { NextResponse: MockNextResponse };
});
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "127.0.0.1",
  checkRateLimit: mockRateLimit,
}));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: mockNotify }));
vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
  getEventTemplate: mockGetEventTemplate,
  renderAndWrap: () => ({ subject: "s", htmlContent: "h", textContent: "t" }),
  brandingFrom: () => ({ email: "from@x.com", name: "From" }),
  brandingCc: () => [],
}));

import { POST } from "@/app/api/public/events/[slug]/reimbursement/[token]/route";
import { GET as uploadsGet } from "@/app/uploads/[...path]/route";

const params = (over?: Record<string, string>) =>
  ({ params: Promise.resolve({ slug: "esh-monthly", token: "tok123", ...over }) }) as never;

function baseRow(over: Record<string, unknown> = {}) {
  return {
    id: "reimb1",
    eventId: "evt1",
    status: "PENDING",
    fullName: null,
    designation: null,
    institution: null,
    country: null,
    email: null,
    phone: null,
    nationality: null,
    passportNumber: null,
    roleAtEvent: null,
    claimLines: null,
    bankDetails: null,
    signedName: null,
    submittedAt: null,
    speaker: {
      id: "spk1",
      title: "DR",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: null,
      organization: "Tawam Hospital",
      jobTitle: "Consultant",
      country: "UAE",
    },
    event: {
      id: "evt1",
      slug: "esh-monthly",
      name: "ESH Monthly Meeting",
      organizationId: "org1",
      bannerImage: null,
      bannerImageMobile: null,
      startDate: new Date("2026-05-18"),
      endDate: new Date("2026-05-18"),
      timezone: "Asia/Dubai",
      eventType: "WEBINAR",
      venue: null,
      city: "Dubai",
      organization: { name: "Meeting Minds" },
    },
    documents: [
      { id: "d1", kind: "PASSPORT", filename: "passport.pdf", size: 1000, createdAt: new Date() },
      { id: "d2", kind: "FLIGHT_RECEIPT", filename: "flight.pdf", size: 1000, createdAt: new Date() },
    ],
    ...over,
  };
}

const validBody = {
  fullName: "Jane Doe",
  country: "United States",
  email: "Jane@Example.com",
  nationality: "American",
  passportNumber: "P1234567",
  roleAtEvent: "Speaker",
  claimLines: [
    { item: "SPEAKER_FEE", currency: "USD", amount: 1000 },
    { item: "FLIGHT", currency: "USD", amount: 850.505 },
  ],
  bankDetails: {
    beneficiaryName: "Jane Doe",
    bankName: "Chase Bank",
    swift: "CHASUS33",
    accountNumber: "12345678",
  },
  signedName: "Jane Doe",
  declarationAccepted: true,
};

const jsonReq = (body: unknown) =>
  ({ json: async () => body, headers: new Map() }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockGetEventTemplate.mockResolvedValue({
    subject: "s",
    htmlContent: "<p>{{claimSummary}}</p>",
    textContent: "{{claimSummaryText}}",
    branding: {},
  });
});

describe("POST /api/public/events/[slug]/reimbursement/[token]", () => {
  it("submits via a conditional claim on PENDING and fires notification + email", async () => {
    mockDb.speakerReimbursement.findUnique.mockResolvedValue(baseRow());
    mockDb.speakerReimbursement.updateMany.mockResolvedValue({ count: 1 });

    const res = await POST(jsonReq(validBody), params());
    expect(res.status).toBe(200);

    const call = mockDb.speakerReimbursement.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "reimb1", status: "PENDING" });
    expect(call.data.status).toBe("SUBMITTED");
    expect(call.data.email).toBe("jane@example.com"); // lowercased
    expect(call.data.submittedIp).toBe("127.0.0.1");
    // amounts rounded to 2dp before storage
    expect(call.data.claimLines).toEqual([
      { item: "SPEAKER_FEE", currency: "USD", amount: 1000 },
      { item: "FLIGHT", currency: "USD", amount: 850.51 },
    ]);

    expect(mockNotify).toHaveBeenCalledOnce();
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });

  it("404s an unknown token", async () => {
    mockDb.speakerReimbursement.findUnique.mockResolvedValue(null);
    const res = await POST(jsonReq(validBody), params());
    expect(res.status).toBe(404);
    expect(mockDb.speakerReimbursement.updateMany).not.toHaveBeenCalled();
  });

  it("404s a valid token pasted under another event's slug", async () => {
    mockDb.speakerReimbursement.findUnique.mockResolvedValue(baseRow());
    const res = await POST(jsonReq(validBody), params({ slug: "other-event" }));
    expect(res.status).toBe(404);
  });

  it("locks a SUBMITTED form with 409", async () => {
    mockDb.speakerReimbursement.findUnique.mockResolvedValue(baseRow({ status: "SUBMITTED" }));
    const res = await POST(jsonReq(validBody), params());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ALREADY_SUBMITTED");
    expect(mockDb.speakerReimbursement.updateMany).not.toHaveBeenCalled();
  });

  it("enforces the receipt rule — names the missing kinds", async () => {
    // Claims a hotel but only passport + flight receipt are uploaded.
    mockDb.speakerReimbursement.findUnique.mockResolvedValue(baseRow());
    const res = await POST(
      jsonReq({
        ...validBody,
        claimLines: [...validBody.claimLines, { item: "HOTEL", currency: "USD", amount: 400 }],
      }),
      params(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_DOCUMENTS");
    expect(body.missing).toEqual(["HOTEL_INVOICE"]);
    expect(mockDb.speakerReimbursement.updateMany).not.toHaveBeenCalled();
  });

  it("returns 409 when the conditional claim loses a double-submit race", async () => {
    mockDb.speakerReimbursement.findUnique.mockResolvedValue(baseRow());
    mockDb.speakerReimbursement.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(jsonReq(validBody), params());
    expect(res.status).toBe(409);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("rejects a payload without the accepted declaration", async () => {
    mockDb.speakerReimbursement.findUnique.mockResolvedValue(baseRow());
    const res = await POST(jsonReq({ ...validBody, declarationAccepted: false }), params());
    expect(res.status).toBe(400);
  });

  it("a mail blip never fails the committed submission", async () => {
    mockDb.speakerReimbursement.findUnique.mockResolvedValue(baseRow());
    mockDb.speakerReimbursement.updateMany.mockResolvedValue({ count: 1 });
    mockSendEmail.mockRejectedValueOnce(new Error("SES down"));
    const res = await POST(jsonReq(validBody), params());
    expect(res.status).toBe(200);
  });
});

describe("public /uploads catch-all — reimbursements prefix blocked", () => {
  it("403s any path under uploads/reimbursements/", async () => {
    const res = (await uploadsGet({} as never, {
      params: Promise.resolve({ path: ["reimbursements", "evt1", "passport.pdf"] }),
    } as never)) as unknown as { status: number };
    expect(res.status).toBe(403);
  });
});
