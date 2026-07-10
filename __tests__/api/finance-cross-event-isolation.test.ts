/**
 * Finance-surface cross-event isolation (payments review H9 + H10, July 10 2026).
 *
 * ONSITE and MEMBER are finance-capable (`FINANCE_ROLES` since June 17), but the
 * invoice/quote GET surface used to org-scope only — an ONSITE temp assigned to
 * Event A could list/export/download ANY org event's invoices and quote PDFs
 * (amounts, attendee PII, bank details). Same class as the July 7 desk-route
 * BLOCKER, which these routes were missed by. These tests pin that every
 * finance lookup now routes through the REAL buildEventAccessWhere:
 *   - ONSITE unassigned → assignment-gated lookup → 404;
 *   - ADMIN stays org-scoped (no assignment gate).
 * Plus H9: manual invoice creation must 404 a registrationId that doesn't
 * belong to the event (it used to mint an invoice from ANY registration).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    invoice: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/invoice-service", () => ({
  createInvoice: vi.fn(),
  cancelInvoice: vi.fn(),
  generatePDFForInvoice: vi.fn(),
  sendInvoiceEmail: vi.fn(),
}));
vi.mock("@/lib/quote-pdf", () => ({ generateQuotePDF: vi.fn(), buildQuotePDFFromRegistration: vi.fn() }));
vi.mock("@/lib/invoice-numbering", () => ({ formatQuoteNumber: vi.fn() }));
// buildEventAccessWhere + denyFinance/denyReviewer are REAL (pure) — the point
// is to prove the routes call the real scoping helper.

import { GET as invoicesGET, POST as invoicesPOST } from "@/app/api/events/[eventId]/invoices/route";
import { GET as invoicePdfGET } from "@/app/api/events/[eventId]/invoices/[invoiceId]/pdf/route";
import { GET as quoteGET } from "@/app/api/events/[eventId]/registrations/[registrationId]/quote/route";

const ONSITE = { user: { id: "onsite1", role: "ONSITE", organizationId: "org1" } };
const ADMIN = { user: { id: "admin1", role: "ADMIN", organizationId: "org1" } };
const eventParams = { params: Promise.resolve({ eventId: "evB" }) };
const quoteParams = { params: Promise.resolve({ eventId: "evB", registrationId: "reg1" }) };
const pdfParams = { params: Promise.resolve({ eventId: "evB", invoiceId: "inv1" }) };

const req = (body?: unknown) =>
  new Request("http://localhost/x", {
    method: body !== undefined ? "POST" : "GET",
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });

function lastEventWhere() {
  return mockDb.event.findFirst.mock.calls.at(-1)?.[0]?.where as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(null); // unassigned by default
  mockDb.invoice.findMany.mockResolvedValue([]);
  mockDb.invoice.findFirst.mockResolvedValue(null);
  mockDb.registration.findFirst.mockResolvedValue(null);
});

describe("invoice LIST — H10", () => {
  it("404s an unassigned ONSITE via the assignment-gated lookup", async () => {
    mockAuth.mockResolvedValue(ONSITE);
    const res = await invoicesGET(req(), eventParams);
    expect(res.status).toBe(404);
    expect(lastEventWhere()).toMatchObject({
      settings: { path: ["onsiteUserIds"], array_contains: "onsite1" },
    });
    expect(mockDb.invoice.findMany).not.toHaveBeenCalled();
  });

  it("keeps an ADMIN org-scoped (no assignment gate)", async () => {
    mockAuth.mockResolvedValue(ADMIN);
    mockDb.event.findFirst.mockResolvedValue({ id: "evB" });
    await invoicesGET(req(), eventParams);
    const where = lastEventWhere();
    expect(where).toHaveProperty("organizationId", "org1");
    expect(where).not.toHaveProperty("settings");
  });
});

describe("invoice PDF — H10", () => {
  it("binds the invoice lookup to the caller's event access (ONSITE unassigned → 404)", async () => {
    mockAuth.mockResolvedValue(ONSITE);
    const res = await invoicePdfGET(req(), pdfParams);
    expect(res.status).toBe(404);
    const where = mockDb.invoice.findFirst.mock.calls.at(-1)?.[0]?.where as Record<string, unknown>;
    expect(where).toMatchObject({
      id: "inv1",
      eventId: "evB",
      event: { settings: { path: ["onsiteUserIds"], array_contains: "onsite1" } },
    });
  });
});

describe("quote PDF — H10", () => {
  it("404s an unassigned ONSITE via the assignment-gated event lookup", async () => {
    mockAuth.mockResolvedValue(ONSITE);
    const res = await quoteGET(req(), quoteParams);
    expect(res.status).toBe(404);
    expect(lastEventWhere()).toMatchObject({
      settings: { path: ["onsiteUserIds"], array_contains: "onsite1" },
    });
  });
});

describe("manual invoice creation — H9", () => {
  it("404s a registrationId that doesn't belong to the event (no cross-event/cross-org mint)", async () => {
    mockAuth.mockResolvedValue(ADMIN);
    mockDb.event.findFirst.mockResolvedValue({ id: "evB" });
    mockDb.registration.findFirst.mockResolvedValue(null); // foreign registration

    const res = await invoicesPOST(req({ registrationId: "reg-of-other-event" }), eventParams);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Registration not found for this event" });
    expect(mockDb.registration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg-of-other-event", eventId: "evB" } }),
    );
    const { createInvoice } = await import("@/lib/invoice-service");
    expect(vi.mocked(createInvoice)).not.toHaveBeenCalled();
  });

  it("creates when the registration belongs to the event", async () => {
    mockAuth.mockResolvedValue(ADMIN);
    mockDb.event.findFirst.mockResolvedValue({ id: "evB" });
    mockDb.registration.findFirst.mockResolvedValue({ id: "reg1" });
    const { createInvoice } = await import("@/lib/invoice-service");
    vi.mocked(createInvoice).mockResolvedValue({ id: "inv1", invoiceNumber: "MM-001" } as never);

    const res = await invoicesPOST(req({ registrationId: "reg1" }), eventParams);
    expect(res.status).toBe(201);
    expect(vi.mocked(createInvoice)).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: "reg1", eventId: "evB", organizationId: "org1" }),
    );
  });
});
