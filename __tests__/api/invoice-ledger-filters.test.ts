/**
 * Org invoice ledger — filter validation (Sep 21, 2026 security review, #6).
 *
 * `type` and `status` were cast straight from the URL:
 *
 *     type: type as Prisma.EnumInvoiceTypeFilter["equals"]
 *
 * A cast converts nothing. It only switches off the one check that would have
 * caught a bad value, so `?status=banana` compiled, reached Postgres as an
 * invalid enum and threw — a 500 on the org's invoice ledger for whoever sent
 * it.
 *
 * Two properties are pinned here, and the second is the one worth arguing
 * about:
 *
 *   1. a valid value still filters (the feature works);
 *   2. an invalid one is REFUSED, not dropped. Silently ignoring an
 *      unparseable filter WIDENS the result set — the caller asked for credit
 *      notes and would get every document type — which is the same class
 *      `parseDateRangeFilters` and `assertValidBulkEmailFilters` already
 *      refuse on. A test that only asserted "no 500" would pass against the
 *      drop-it-silently implementation too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockApiLogger, mockDenyFinance } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    invoice: {
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockDenyFinance: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth-guards", () => ({ denyFinance: (...a: unknown[]) => mockDenyFinance(...a) }));
vi.mock("@/lib/invoice-export", () => ({ invoiceDateFilter: () => [] }));
// Pass-through: the lane is exercised by the tenancy harness, not here.
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));

import { GET } from "@/app/api/invoices/route";

const adminSession = { user: { id: "u1", role: "ADMIN", organizationId: "org-1" } };

function req(qs = "") {
  return new Request(`http://localhost/api/invoices${qs ? `?${qs}` : ""}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
  mockDenyFinance.mockReturnValue(null);
  mockDb.invoice.aggregate.mockResolvedValue({ _min: { issueDate: new Date("2026-01-01T00:00:00Z") } });
  mockDb.invoice.findMany.mockResolvedValue([]);
});

describe("GET /api/invoices — type filter", () => {
  it("accepts a real InvoiceType and puts it in the where", async () => {
    const res = await GET(req("type=CREDIT_NOTE"));
    expect(res.status).toBe(200);
    const where = mockDb.invoice.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.type).toBe("CREDIT_NOTE");
    expect(where.organizationId).toBe("org-1");
  });

  it("refuses an unknown type with 400 INVALID_FILTER and never queries", async () => {
    const res = await GET(req("type=banana"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FILTER");
    // Refused, not silently widened to "every type".
    expect(mockDb.invoice.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/invoices — status filter", () => {
  it("accepts a real InvoiceStatus", async () => {
    const res = await GET(req("status=PAID"));
    expect(res.status).toBe(200);
    const where = mockDb.invoice.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.status).toBe("PAID");
  });

  it("refuses an unknown status rather than 500ing on the Postgres enum", async () => {
    const res = await GET(req("status=banana"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_FILTER");
    expect(mockDb.invoice.findMany).not.toHaveBeenCalled();
  });

  it("is case-sensitive: the enum is upper-case, so 'paid' is not a real value", async () => {
    const res = await GET(req("status=paid"));
    expect(res.status).toBe(400);
  });

  it("logs the refusal — a filter rejection must never be silent", async () => {
    await GET(req("status=banana"));
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "org-invoices:invalid-filter", filter: "status" }),
    );
  });

  it("does NOT echo the caller's value back in the response", async () => {
    const res = await GET(req("status=%3Cscript%3E"));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("script");
  });
});

describe("GET /api/invoices — absent filters", () => {
  it("omits both keys entirely when neither is supplied", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const where = mockDb.invoice.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect("type" in where).toBe(false);
    expect("status" in where).toBe(false);
  });
});
