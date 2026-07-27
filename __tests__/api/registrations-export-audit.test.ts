/**
 * GET /api/events/[eventId]/registrations?export=csv
 *
 * This export replaced an in-browser Blob download that never reached the
 * server and therefore could not be audited at all. These tests pin the two
 * things that made the move worth doing:
 *
 *   1. the pull is RECORDED (who, how many rows, under which filters), and
 *   2. the CSV inherits the SAME redaction the JSON list applies, so moving it
 *      server-side did not hand a non-finance role data it couldn't see before.
 *
 * `registration-export` and `csv-escape` are deliberately NOT mocked — the test
 * asserts against the real produced file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const {
  mockGetOrgContext,
  mockDb,
  mockRecordExport,
  mockCanViewFinance,
  mockRedactFinancial,
  mockCanViewBarcode,
  mockRedactBarcode,
} = vi.hoisted(() => ({
  mockGetOrgContext: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    invoice: { groupBy: vi.fn().mockResolvedValue([]) },
  },
  mockRecordExport: vi.fn(),
  mockCanViewFinance: vi.fn(() => true),
  mockRedactFinancial: vi.fn((p: unknown) => p),
  mockCanViewBarcode: vi.fn(() => true),
  mockRedactBarcode: vi.fn((p: unknown) => p),
}));

vi.mock("next/server", () => ({
  NextResponse: class {
    body: unknown;
    status: number;
    headers: Map<string, string>;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Map(Object.entries(init?.headers ?? {}));
    }
    static json(body: unknown, init?: { status?: number }) {
      const r = new (this as never as { new (b: unknown, i?: unknown): Record<string, unknown> })(body, init);
      (r as Record<string, unknown>).json = async () => body;
      return r;
    }
  },
}));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: mockGetOrgContext }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport: mockRecordExport }));
vi.mock("@/lib/event-access", () => ({ buildEventAccessWhere: () => ({ id: "evt_1" }) }));
vi.mock("@/lib/finance-visibility", () => ({
  canViewFinance: mockCanViewFinance,
  redactFinancialFields: mockRedactFinancial,
}));
vi.mock("@/lib/barcode-visibility", () => ({
  canViewEntryBarcode: mockCanViewBarcode,
  redactBarcodeFields: mockRedactBarcode,
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: vi.fn() }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: vi.fn(), REGISTRATION_DESK_ALLOW: [] }));
vi.mock("@/services/registration-service", () => ({ createRegistration: vi.fn() }));

import { GET } from "@/app/api/events/[eventId]/registrations/route";

const REG = {
  id: "reg_1",
  serialId: 3,
  status: "CONFIRMED",
  paymentStatus: "UNPAID",
  createdAt: new Date("2026-03-15T08:00:00Z"),
  checkedInAt: null,
  dtcmBarcode: "DTCM-9",
  discountAmount: 0,
  originalPrice: 100,
  refundedAmount: 0,
  utmSource: "linkedin",
  utmMedium: null,
  utmCampaign: null,
  referrer: null,
  attendee: {
    title: "Dr",
    role: "PHYSICIAN",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    organization: "Tawam",
    tags: ["vip"],
    registrationType: "Physician",
  },
  ticketType: { id: "tt_1", name: "Physician", isFaculty: false, currency: "USD", price: 100 },
  pricingTier: null,
  billingAccount: { name: "Cleveland Clinic" },
  promoCode: null,
  payments: [{ status: "PAID", amount: 40 }],
};

function call(query: string) {
  return GET(new Request(`https://x.test/api/events/evt_1/registrations?${query}`), {
    params: Promise.resolve({ eventId: "evt_1" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCanViewFinance.mockReturnValue(true);
  mockCanViewBarcode.mockReturnValue(true);
  mockRedactFinancial.mockImplementation((p: unknown) => p);
  mockRedactBarcode.mockImplementation((p: unknown) => p);
  mockGetOrgContext.mockResolvedValue({
    organizationId: "org_1",
    userId: "usr_1",
    role: "ORGANIZER",
    fromApiKey: false,
  });
  mockDb.event.findFirst.mockResolvedValue({ id: "evt_1", taxRate: 5, taxLabel: "VAT" });
  mockDb.registration.findMany.mockResolvedValue([REG]);
  mockDb.invoice.groupBy.mockResolvedValue([]);
});

describe("registrations CSV export", () => {
  it("streams a CSV with the header row and one row per registration", async () => {
    const res = (await call("export=csv")) as unknown as { body: string; headers: Map<string, string> };
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("registrations-evt_1.csv");

    const lines = res.body.split("\n");
    expect(lines[0]).toContain("Registration ID");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("jane@example.com");
  });

  it("records the export — who, how many rows, and the format", async () => {
    await call("export=csv");
    expect(mockRecordExport).toHaveBeenCalledTimes(1);
    expect(mockRecordExport.mock.calls[0][1]).toMatchObject({
      entityType: "Registration",
      eventId: "evt_1",
      organizationId: "org_1",
      userId: "usr_1",
      role: "ORGANIZER",
      rowCount: 1,
      format: "csv",
    });
  });

  it("records the filters that narrowed the pull", async () => {
    await call("export=csv&status=CONFIRMED&paymentStatus=UNPAID&ticketTypeId=tt_1&tags=vip&q=jane");
    expect(mockRecordExport.mock.calls[0][1].filters).toMatchObject({
      status: "CONFIRMED",
      paymentStatus: "UNPAID",
      ticketTypeId: "tt_1",
      tags: ["vip"],
      q: "jane",
    });
  });

  it("does NOT record an export for the ordinary JSON list request", async () => {
    await call("");
    expect(mockRecordExport).not.toHaveBeenCalled();
  });

  // The reason the export lives on the list route: it inherits the gate.
  it("404s without producing a file when the caller can't reach the event", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = (await call("export=csv")) as unknown as { status: number };
    expect(res.status).toBe(404);
    expect(mockRecordExport).not.toHaveBeenCalled();
  });

  it("401s for an unauthenticated caller", async () => {
    mockGetOrgContext.mockResolvedValue(null);
    const res = (await call("export=csv")) as unknown as { status: number };
    expect(res.status).toBe(401);
    expect(mockRecordExport).not.toHaveBeenCalled();
  });

  // Moving the CSV server-side must not widen what a role can see.
  it("applies finance redaction to the CSV for a non-finance role", async () => {
    mockCanViewFinance.mockReturnValue(false);
    mockRedactFinancial.mockImplementation((rows: unknown) =>
      (rows as Record<string, unknown>[]).map((r) => {
        const copy = { ...r };
        delete copy.payments;
        delete copy.billingAccount;
        return copy;
      }),
    );

    const res = (await call("export=csv")) as unknown as { body: string };
    expect(mockRedactFinancial).toHaveBeenCalled();
    // Payer name gone, and the money columns are blank rather than wrong.
    expect(res.body).not.toContain("Cleveland Clinic");
  });

  it("applies barcode redaction to the CSV for a role that doesn't run the door", async () => {
    mockCanViewBarcode.mockReturnValue(false);
    mockRedactBarcode.mockImplementation((rows: unknown) =>
      (rows as Record<string, unknown>[]).map((r) => {
        const copy = { ...r };
        delete copy.dtcmBarcode;
        return copy;
      }),
    );

    const res = (await call("export=csv")) as unknown as { body: string };
    expect(mockRedactBarcode).toHaveBeenCalled();
    expect(res.body).not.toContain("DTCM-9");
  });

  it("merges the tag filter and the free-text search into ONE attendee where", async () => {
    await call("export=csv&tags=vip&q=jane");
    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    // Both constraints must survive — an overwritten `attendee` key would
    // silently widen the export.
    expect(where.attendee.tags).toEqual({ hasSome: ["vip"] });
    expect(where.attendee.OR).toHaveLength(4);
  });
});

/**
 * Regression guard for the export URL the Registrations page builds.
 *
 * The server correctly honours `tags`, and a test above proves it. But the
 * BUG was in the CALLER: the page omitted `tagFilter` from the export URL, so
 * an organizer who filtered to `committee` (12 rows on screen) received a CSV
 * of the ENTIRE attendee book. The server-side test passed the whole time —
 * this repo's "a test can pass against the bug it's meant to catch" lesson.
 *
 * Asserted against source because the alternative is standing up the whole
 * page; the invariant is simply "every filter the table applies is sent".
 */
describe("registrations page export URL", () => {
  const src = readFileSync(
    "src/app/(dashboard)/events/[eventId]/registrations/page.tsx",
    "utf8",
  );
  const builder = /const exportToCSV = async \(\) => \{[\s\S]*?const res = await fetch/.exec(src);

  it("sends every filter the table itself applies", () => {
    expect(builder, "exportToCSV builder not found").toBeTruthy();
    const body = builder![0];
    for (const [param, state] of [
      ["status", "statusFilter"],
      ["paymentStatus", "paymentFilter"],
      ["ticketTypeId", "ticketFilter"],
      // The one that was missing — and the most dangerous, because the tag
      // filter is applied SERVER-side on the table's query, so omitting it
      // widens from "the filtered subset" to "everything".
      ["tags", "tagFilter"],
      ["q", "searchQuery"],
    ] as const) {
      expect(body, `export URL omits ${param}`).toContain(`p.set("${param}"`);
      expect(body, `export URL doesn't read ${state}`).toContain(state);
    }
  });
});
