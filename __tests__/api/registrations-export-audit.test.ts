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
  mockDenyExport,
  mockCheckRateLimit,
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
  mockDenyExport: vi.fn<(...a: unknown[]) => { status: number; json: () => Promise<unknown> } | null>(() => null),
  mockCheckRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
}));

// Sponsors moved from Event.settings JSON to their own table (Sep 2 2026). These
// suites do not exercise sponsor attribution, so the module is stubbed empty
// rather than each db mock growing a `sponsor` delegate it never asserts on.
vi.mock("@/lib/sponsors", () => ({
  getSponsors: vi.fn(async () => []),
  getSponsorNameMap: vi.fn(async () => new Map()),
  sponsorExistsOnEvent: vi.fn(async () => false),
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
// Mock only recordExport — `fingerprintSearchTerm` is a pure sha256 helper, so
// the test asserts the REAL digest rather than a stub's shape.
vi.mock("@/lib/audit-data-transfer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit-data-transfer")>()),
  recordExport: mockRecordExport,
}));
// Spread the real module and override ONLY the predicate under test, so adding
// an export to event-access can't break this file the way it did on Aug 10.
vi.mock("@/lib/event-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/event-access")>()),
  buildEventAccessWhere: () => ({ id: "evt_1" }),
}));
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
vi.mock("@/lib/registration-export-visibility", () => ({ denyRegistrationExport: mockDenyExport }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: mockCheckRateLimit }));
vi.mock("@/lib/api-errors", () => ({
  rateLimited: (rl: { retryAfterSeconds: number }) => ({ status: 429, json: async () => ({ code: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds }) }),
}));
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
  mockDenyExport.mockReturnValue(null);
  mockCheckRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
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
      // `q` itself is deliberately absent — see "audit payload hygiene" below.
      qLength: 4,
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
  // Tolerates parameters: the builder gained a variant ("csv" | "sales") and
  // an optional group scope. The invariant it guards is unchanged.
  const builder = /const exportToCSV = async \([\s\S]*?\) => \{[\s\S]*?const res = await fetch/.exec(src);

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
      // Same class as tags and for a stronger reason: the sponsor filter is a
      // three-way union the client cannot reproduce, so it is applied
      // SERVER-side too. Omit it and an organiser filtered to one sponsor
      // downloads the whole attendee book.
      ["sponsorId", "sponsorFilter"],
      ["q", "searchQuery"],
    ] as const) {
      expect(body, `export URL omits ${param}`).toContain(`p.set("${param}"`);
      expect(body, `export URL doesn't read ${state}`).toContain(state);
    }
  });

  it("only skips the page filters when an explicit group scope was asked for", () => {
    // The group export deliberately ignores the page filters — the operator
    // asked for THAT group, not that group minus whatever is filtered on
    // screen. That widening must stay bounded to the scoped case: an
    // unguarded skip would silently turn the normal export back into a full
    // attendee-book dump, which is the exact bug this file exists to catch.
    const body = builder![0];
    for (const guarded of ['if (!scopeGroupId)']) {
      expect(body, "filters are skipped without a group scope guard").toContain(guarded);
    }
    // And when scoped, the group id is what narrows it.
    expect(body).toContain('p.set("groupId", scopeGroupId)');
  });
});

describe("export gate + rate limit", () => {
  it("403s before touching the database when the role may not export", async () => {
    mockDenyExport.mockReturnValue({ status: 403, json: async () => ({ code: "EXPORT_FORBIDDEN" }) });
    const res = (await call("export=csv")) as unknown as { status: number };
    expect(res.status).toBe(403);
    // The point of gating pre-flight: no unbounded query, no audit row.
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
    expect(mockRecordExport).not.toHaveBeenCalled();
  });

  it("429s before touching the database when the budget is spent", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 900 });
    const res = (await call("export=csv")) as unknown as { status: number };
    expect(res.status).toBe(429);
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
    expect(mockRecordExport).not.toHaveBeenCalled();
  });

  it("leaves the ordinary JSON list ungated and unthrottled", async () => {
    await call("");
    expect(mockDenyExport).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe("audit payload hygiene", () => {
  it("stores a fingerprint of the search term, never the term itself", async () => {
    await call("export=csv&q=jane.doe%40pharmaco.com");
    const filters = mockRecordExport.mock.calls[0][1].filters;
    // Operators search full email addresses; AuditLog has no prune job and
    // survives a subject-erasure request, so the raw term must not persist.
    expect(JSON.stringify(filters)).not.toContain("pharmaco");
    expect(filters.qLength).toBe("jane.doe@pharmaco.com".length);
    expect(filters.qFingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("records date-range narrowing so an incremental pull isn't mistaken for a full dump", async () => {
    await call("export=csv&createdAfter=2026-01-01&updatedBefore=2026-06-30");
    expect(mockRecordExport.mock.calls[0][1].filters).toMatchObject({
      createdAfter: "2026-01-01",
      updatedBefore: "2026-06-30",
    });
  });
});

describe("filter validation", () => {
  it("rejects a malformed status instead of silently widening the export", async () => {
    const res = (await call("export=csv&status=CONFIRMD")) as unknown as {
      status: number; json: () => Promise<{ code: string }>;
    };
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_FILTER");
    expect(mockRecordExport).not.toHaveBeenCalled();
  });

  it("rejects a malformed paymentStatus", async () => {
    const res = (await call("export=csv&paymentStatus=PIAD")) as unknown as { status: number };
    expect(res.status).toBe(400);
  });

  it("escapes LIKE wildcards so the file can't match more rows than the screen", async () => {
    await call("export=csv&q=50%25");
    const or = mockDb.registration.findMany.mock.calls[0][0].where.attendee.OR;
    // `%` must reach Postgres escaped, or ILIKE treats it as match-anything
    // while the page's String.includes treats it literally.
    expect(or[0].firstName.contains).toBe("50\\%");
  });
});
