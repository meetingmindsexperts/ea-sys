/**
 * Finance boundary on the three registrant-scoped routes that expose
 * financial PDFs / data:
 *   - GET /api/registrant/registrations/[id]/quote
 *   - GET /api/registrant/registrations/[id]/invoices
 *   - GET /api/registrant/registrations/[id]/invoices/[invoiceId]/pdf
 *
 * History:
 *   - May 18, 2026 (audit HIGH): the non-registrant branch scoped only by org,
 *     so any org member got the financial PDF. Fixed by running denyFinance()
 *     before the DB query.
 *   - June 17, 2026: MEMBER + ONSITE became registration-desk operators who
 *     SEE money (canViewFinance now includes them), so they PASS the guard. The
 *     guard still blocks genuinely non-finance roles (REVIEWER/SUBMITTER/
 *     REGISTRANT via the non-owner branch). REGISTRANT owners stay exempt
 *     (viewing your own quote/invoice is the point of the portal).
 *
 * These tests are the regression net for the denyFinance boundary.
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

// PDF generators throw if reached — proves the finance guard fired BEFORE any
// PDF work happened for a blocked role.
vi.mock("@/lib/quote-pdf", () => ({
  buildQuotePDFFromRegistration: vi.fn(() => {
    throw new Error("PDF generator should not be reached for a blocked role");
  }),
}));
vi.mock("@/lib/invoice-service", () => ({
  generatePDFForInvoice: vi.fn(() => {
    throw new Error("PDF generator should not be reached for a blocked role");
  }),
}));

import { GET as quoteGET } from "@/app/api/registrant/registrations/[registrationId]/quote/route";
import { GET as invoicesGET } from "@/app/api/registrant/registrations/[registrationId]/invoices/route";
import { GET as invoicePdfGET } from "@/app/api/registrant/registrations/[registrationId]/invoices/[invoiceId]/pdf/route";

// REVIEWER is non-finance and org-independent (organizationId=null) and not a
// REGISTRANT owner, so it's rejected by the non-registrant branch's
// "must have an org" guard with a plain 403. (Since every org-BOUND role is now
// finance-visible, the denyFinance/FINANCE_FORBIDDEN path is defense-in-depth
// that no current role reaches.)
const blockedSession = {
  user: { id: "user-reviewer", role: "REVIEWER", organizationId: null },
};
// MEMBER is now a finance role — it must PASS the guard.
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
  it("an org-independent non-registrant is blocked with 403 before any DB read", async () => {
    mockAuth.mockResolvedValue(blockedSession);
    const res = await quoteGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Forbidden");
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("MEMBER now PASSES the finance guard (it records payments — reaches the lookup)", async () => {
    mockAuth.mockResolvedValue(memberSession);
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await quoteGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(404); // not 403 — guard let it through, row just absent
    expect(mockDb.registration.findFirst).toHaveBeenCalled();
  });

  it("REGISTRANT owner is NOT blocked by denyFinance (owner-scoped exempt branch)", async () => {
    mockAuth.mockResolvedValue(registrantSession);
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await quoteGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(404);
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
  it("an org-independent non-registrant is blocked with 403 before any DB read", async () => {
    mockAuth.mockResolvedValue(blockedSession);
    const res = await invoicesGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Forbidden");
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
    expect(mockDb.invoice.findMany).not.toHaveBeenCalled();
  });

  it("MEMBER passes the finance guard and reaches the lookup", async () => {
    mockAuth.mockResolvedValue(memberSession);
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await invoicesGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(404);
    expect(mockDb.registration.findFirst).toHaveBeenCalled();
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
  it("an org-independent non-registrant is blocked with 403 before any DB read", async () => {
    mockAuth.mockResolvedValue(blockedSession);
    const res = await invoicePdfGET(req(), {
      params: Promise.resolve({ registrationId: "r1", invoiceId: "inv1" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Forbidden");
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
