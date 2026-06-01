/**
 * Unit tests pinning the finance boundary on the three registrant-scoped
 * routes that expose financial PDFs / data:
 *   - GET /api/registrant/registrations/[id]/quote
 *   - GET /api/registrant/registrations/[id]/invoices
 *   - GET /api/registrant/registrations/[id]/invoices/[invoiceId]/pdf
 *
 * Pre-fix (audit-hardening HIGH, May 18 review): the non-registrant
 * branch scoped only by org. A MEMBER (org-bound read-only viewer) has
 * an organizationId, so passed straight through and got the financial
 * PDF — a direct breach of the canViewFinance() boundary.
 *
 * Post-fix (Core Stability Pass #1, June 2026): the non-registrant
 * branch runs denyFinance() before the DB query. REGISTRANT branch is
 * owner-scoped and stays exempt — viewing your own quote/invoice is
 * the whole point of the registrant portal.
 *
 * These tests must keep passing — they are the regression net for the
 * exact class of bug we just closed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    registration: { findFirst: vi.fn() },
    invoice: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// PDF generators throw if reached — proves the finance guard fired BEFORE
// any PDF work happened. If MEMBER ever slips through again, the test
// will fail with a clear "generator was called" error rather than a
// confusing 500 from the mock.
vi.mock("@/lib/quote-pdf", () => ({
  buildQuotePDFFromRegistration: vi.fn(() => {
    throw new Error("PDF generator should not be reached for MEMBER");
  }),
}));
vi.mock("@/lib/invoice-service", () => ({
  generatePDFForInvoice: vi.fn(() => {
    throw new Error("PDF generator should not be reached for MEMBER");
  }),
}));

import { GET as quoteGET } from "@/app/api/registrant/registrations/[registrationId]/quote/route";
import { GET as invoicesGET } from "@/app/api/registrant/registrations/[registrationId]/invoices/route";
import { GET as invoicePdfGET } from "@/app/api/registrant/registrations/[registrationId]/invoices/[invoiceId]/pdf/route";

const memberSession = {
  user: { id: "user-member", role: "MEMBER", organizationId: "org-1" },
};
const registrantSession = {
  user: { id: "user-reg", role: "REGISTRANT", organizationId: null },
};
const adminSession = {
  user: { id: "user-admin", role: "ADMIN", organizationId: "org-1" },
};

function req() {
  return new Request("http://localhost/api/x");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registrant /quote — finance boundary", () => {
  it("MEMBER is blocked with 403 FINANCE_FORBIDDEN before any DB read", async () => {
    mockAuth.mockResolvedValue(memberSession);
    const res = await quoteGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("FINANCE_FORBIDDEN");
    // The DB must not have been touched — the guard ran first.
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("REGISTRANT owner is NOT blocked by denyFinance (owner-scoped exempt branch)", async () => {
    mockAuth.mockResolvedValue(registrantSession);
    // Force the query to return null so we exit cleanly without invoking the
    // PDF mock (which would throw). The point of the test is "we got past
    // the finance guard," not "we generated a PDF."
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await quoteGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(404); // not 403 — the guard let us through, the row just didn't exist
    expect(mockDb.registration.findFirst).toHaveBeenCalled();
  });

  it("ADMIN passes the finance guard (canViewFinance is true)", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await quoteGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(404);
    expect(mockDb.registration.findFirst).toHaveBeenCalled();
  });
});

describe("registrant /invoices — finance boundary", () => {
  it("MEMBER is blocked with 403 FINANCE_FORBIDDEN before any DB read", async () => {
    mockAuth.mockResolvedValue(memberSession);
    const res = await invoicesGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("FINANCE_FORBIDDEN");
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
    expect(mockDb.invoice.findMany).not.toHaveBeenCalled();
  });

  it("REGISTRANT owner reaches the registration lookup", async () => {
    mockAuth.mockResolvedValue(registrantSession);
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await invoicesGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(404);
    expect(mockDb.registration.findFirst).toHaveBeenCalled();
  });
});

describe("registrant /invoices/[invoiceId]/pdf — finance boundary", () => {
  it("MEMBER is blocked with 403 FINANCE_FORBIDDEN before any DB read", async () => {
    mockAuth.mockResolvedValue(memberSession);
    const res = await invoicePdfGET(req(), {
      params: Promise.resolve({ registrationId: "r1", invoiceId: "inv1" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("FINANCE_FORBIDDEN");
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
    expect(mockDb.invoice.findFirst).not.toHaveBeenCalled();
  });

  it("REGISTRANT owner reaches the registration lookup", async () => {
    mockAuth.mockResolvedValue(registrantSession);
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await invoicePdfGET(req(), {
      params: Promise.resolve({ registrationId: "r1", invoiceId: "inv1" }),
    });
    expect(res.status).toBe(404);
    expect(mockDb.registration.findFirst).toHaveBeenCalled();
  });
});
