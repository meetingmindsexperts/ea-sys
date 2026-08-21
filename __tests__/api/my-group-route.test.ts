/**
 * My Group portal — the coordinator's own read surface (group Phase 3).
 *
 * The properties worth pinning are all about who can see what: ownership is
 * `coordinatorUserId` (not org — a coordinator is an org-null REGISTRANT), and
 * a member's entry barcode must never leave this route, because it is a
 * physical-access credential and the coordinator is not staff.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockGeneratePdf, mockRateLimit } = vi.hoisted(() => ({
  mockDb: {
    registrationGroup: { findMany: vi.fn() },
    invoice: { findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockGeneratePdf: vi.fn(async () => Buffer.from("%PDF-1.4 fake")),
  mockRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
}));

vi.mock("next/server", () => ({
  NextResponse: class {
    status: number;
    headers: Map<string, string>;
    private body: unknown;
    constructor(body: unknown, init?: { headers?: Record<string, string> }) {
      this.body = body;
      this.status = 200;
      this.headers = new Map(Object.entries(init?.headers ?? {}));
    }
    static json(body: unknown, init?: { status?: number }) {
      return {
        status: init?.status ?? 200,
        json: async () => body,
        headers: { get: () => null },
      };
    }
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockRateLimit }));
vi.mock("@/lib/invoice-service", () => ({ generatePDFForInvoice: mockGeneratePdf }));

import { GET as getMyGroup } from "@/app/api/registrant/my-group/route";

/** The handler now takes a Request: the tenant lane comes from the Host. */
const req = () => new Request("http://localhost/api/registrant/my-group");
import { GET as getInvoice } from "@/app/api/registrant/my-group/[groupId]/invoice/[invoiceId]/route";

const GROUP_ROW = {
  id: "grp-1",
  createdAt: new Date("2026-08-01"),
  coordinatorName: "Layla Hassan",
  coordinatorEmail: "layla@corp.com",
  coordinatorAttending: true,
  payerReference: "PO-1",
  billingAccount: { name: "Gulf Heart Institute", contactName: "Finance", email: "fin@corp.com" },
  event: {
    id: "ev1", name: "BigSky", slug: "BIGSKY", startDate: new Date("2027-03-01"), endDate: null,
    venue: "Madinat", city: "Dubai", bannerImage: null, bannerImageMobile: null,
    taxRate: 5, taxLabel: "VAT",
    settings: { groupRegistration: { enabled: true, minMembers: 2, maxMembers: 20 } },
  },
  registrations: [
    {
      id: "reg-1", serialId: 1, status: "CONFIRMED", paymentStatus: "UNPAID",
      checkedInAt: null, originalPrice: 100, qrCode: "SECRET-BARCODE-123",
      ticketType: { name: "Physician", currency: "USD" }, pricingTier: null,
      attendee: {
        title: "DR", firstName: "Ahmed", lastName: "Osman", email: "a@corp.com",
        organization: "Corp", jobTitle: "Consultant", phone: "+971", city: "Dubai", country: "AE",
      },
    },
    {
      id: "reg-2", serialId: 2, status: "CANCELLED", paymentStatus: "UNPAID",
      checkedInAt: null, originalPrice: 150, qrCode: null,
      ticketType: { name: "Allied Health", currency: "USD" }, pricingTier: null,
      attendee: {
        title: null, firstName: "John", lastName: "Reyes", email: "j@corp.com",
        organization: null, jobTitle: null, phone: null, city: null, country: null,
      },
    },
  ],
  invoices: [
    {
      id: "inv-1", invoiceNumber: "BSK-INV-001", type: "INVOICE", status: "SENT",
      issueDate: new Date("2026-08-01"), dueDate: new Date("2026-09-01"), paidDate: null,
      subtotal: 250, taxAmount: 12.5, total: 262.5, currency: "USD",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  mockDb.registrationGroup.findMany.mockResolvedValue([GROUP_ROW]);
});

describe("GET /api/registrant/my-group", () => {
  it("401s when signed out", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await getMyGroup(req());
    expect(res.status).toBe(401);
    expect(mockDb.registrationGroup.findMany).not.toHaveBeenCalled();
  });

  it("binds to the caller's coordinatorUserId — never to an org", async () => {
    await getMyGroup(req());
    const where = mockDb.registrationGroup.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ coordinatorUserId: "user-1" });
    expect(JSON.stringify(where)).not.toContain("organizationId");
  });

  it("NEVER returns a member's entry barcode", async () => {
    const res = await getMyGroup(req());
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("SECRET-BARCODE-123");
    // ...but does say whether a badge exists, which is what a coordinator needs.
    expect(body.groups[0].members[0].badgeIssued).toBe(true);
    expect(body.groups[0].members[1].badgeIssued).toBe(false);
  });

  it("counts live members and reports cancellations separately", async () => {
    const body = await (await getMyGroup(req())).json();
    expect(body.groups[0].memberCount).toBe(1);
    expect(body.groups[0].cancelledCount).toBe(1);
    // Subtotal excludes the cancelled member.
    expect(body.groups[0].subtotal).toBe(100);
  });

  it("reports the open invoice as the amount due", async () => {
    const body = await (await getMyGroup(req())).json();
    expect(body.groups[0].amountDue).toBe(262.5);
    expect(body.groups[0].isPaid).toBe(false);
  });

  it("is paid once no open invoice remains", async () => {
    mockDb.registrationGroup.findMany.mockResolvedValue([
      { ...GROUP_ROW, invoices: [{ ...GROUP_ROW.invoices[0], status: "PAID", paidDate: new Date() }] },
    ]);
    const body = await (await getMyGroup(req())).json();
    expect(body.groups[0].isPaid).toBe(true);
    expect(body.groups[0].amountDue).toBe(0);
  });

  it("500s rather than pretending the coordinator has no group", async () => {
    mockDb.registrationGroup.findMany.mockRejectedValue(new Error("db down"));
    const res = await getMyGroup(req());
    expect(res.status).toBe(500);
  });
});

describe("GET /api/registrant/my-group/[groupId]/invoice/[invoiceId]", () => {
  const params = (groupId = "grp-1", invoiceId = "inv-1") => ({
    params: Promise.resolve({ groupId, invoiceId }),
  });
  const req = new Request("http://localhost/x");

  it("401s when signed out", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await getInvoice(req, params());
    expect(res.status).toBe(401);
    expect(mockGeneratePdf).not.toHaveBeenCalled();
  });

  it("binds the invoice to a group the caller coordinates, in ONE predicate", async () => {
    mockDb.invoice.findFirst.mockResolvedValue({ id: "inv-1", invoiceNumber: "BSK-INV-001" });
    await getInvoice(req, params());
    expect(mockDb.invoice.findFirst.mock.calls[0][0].where).toEqual({
      id: "inv-1",
      groupId: "grp-1",
      group: { coordinatorUserId: "user-1" },
    });
  });

  it("404s a foreign invoice without rendering anything", async () => {
    mockDb.invoice.findFirst.mockResolvedValue(null);
    const res = await getInvoice(req, params("grp-other", "inv-other"));
    expect(res.status).toBe(404);
    expect(mockGeneratePdf).not.toHaveBeenCalled();
  });

  it("429s before doing CPU-bound PDF work", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await getInvoice(req, params());
    expect(res.status).toBe(429);
    expect(mockDb.invoice.findFirst).not.toHaveBeenCalled();
    expect(mockGeneratePdf).not.toHaveBeenCalled();
  });

  it("streams the PDF for an owned invoice", async () => {
    mockDb.invoice.findFirst.mockResolvedValue({ id: "inv-1", invoiceNumber: "BSK-INV-001" });
    const res = await getInvoice(req, params());
    expect(mockGeneratePdf).toHaveBeenCalledWith("inv-1");
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });
});
