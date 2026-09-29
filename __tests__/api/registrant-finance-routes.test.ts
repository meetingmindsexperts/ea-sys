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
 *   - Sep 29, 2026: EVERY org-less account is owner-scoped, not only
 *     REGISTRANT. A SUBMITTER owns a registration when they are a speaker (the
 *     faculty companion) or paid a presenter rate, and was refused its own
 *     quote, invoices and barcode with a 403. Owner-scoped means the lookup
 *     filters on the caller's userId, so an org-less account still reaches
 *     nothing it does not own (404), and never an event-wide lookup.
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

// Org-less, non-REGISTRANT accounts: owner-scoped since Sep 29 2026. A
// REVIEWER that owns nothing gets a 404; a SUBMITTER that owns its
// registration (speaker companion / presenter rate) gets it.
const orglessSession = {
  user: { id: "user-reviewer", role: "REVIEWER", organizationId: null },
};
const submitterSession = {
  user: { id: "user-sub", role: "SUBMITTER", organizationId: null },
};

/** The lookup was owner-scoped to this user, never event-scoped. */
function expectOwnerScoped(userId: string) {
  const where = mockDb.registration.findFirst.mock.calls[0][0].where;
  expect(where.userId).toBe(userId);
  expect(where.event).toBeUndefined();
}
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
  it("an org-less non-registrant is owner-scoped: a row it does not own is a 404", async () => {
    mockAuth.mockResolvedValue(orglessSession);
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await quoteGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(404);
    expectOwnerScoped("user-reviewer");
  });

  it("a SUBMITTER is owner-scoped too (its companion / presenter registration)", async () => {
    mockAuth.mockResolvedValue(submitterSession);
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await quoteGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(404);
    expectOwnerScoped("user-sub");
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
  it("an org-less non-registrant is owner-scoped: a row it does not own is a 404", async () => {
    mockAuth.mockResolvedValue(orglessSession);
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await invoicesGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(404);
    expectOwnerScoped("user-reviewer");
    expect(mockDb.invoice.findMany).not.toHaveBeenCalled();
  });

  it("a SUBMITTER owner reaches its own invoices", async () => {
    mockAuth.mockResolvedValue(submitterSession);
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1" });
    mockDb.invoice.findMany.mockResolvedValue([]);
    const res = await invoicesGET(req(), { params: Promise.resolve({ registrationId: "r1" }) });
    expect(res.status).toBe(200);
    expectOwnerScoped("user-sub");
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
  it("an org-less non-registrant is owner-scoped: a row it does not own is a 404", async () => {
    mockAuth.mockResolvedValue(orglessSession);
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await invoicePdfGET(req(), {
      params: Promise.resolve({ registrationId: "r1", invoiceId: "inv1" }),
    });
    expect(res.status).toBe(404);
    expectOwnerScoped("user-reviewer");
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
