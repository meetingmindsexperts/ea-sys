/**
 * DTCM barcode import — assign vs spares (Aug 26, 2026).
 *
 * THE BUG THIS CLOSES. The route required a `registrationId` or `email` column
 * and 400'd without one, which is correct for a file of assignments and made
 * the spare pool UNFILLABLE: a block of leftover codes has, by definition, no
 * owner column. The pool shipped and could never be given anything.
 *
 * THE BUG THIS MUST NOT OPEN. Simply dropping the guard would mean a file whose
 * owner column is called `attendee_email` — a header we do not recognise — has
 * every row fall through to the spares branch. Two hundred intended assignments
 * become two hundred unclaimed codes, the people they were meant for arrive
 * with none, and the import reports success. So the mode is DECLARED by the
 * operator, never inferred from the headers. Same rule the Freshsales importer
 * settled on for date order: a guess that is usually right is exactly the
 * failure mode.
 *
 * `parseCSV` and `findCol` are REAL here — header detection is the thing under
 * test, so mocking it would test the mock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockLogger, mockImportDtcmCodes, mockRecordImport } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn(), update: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockImportDtcmCodes: vi.fn(),
  mockRecordImport: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/audit-data-transfer", () => ({ recordImport: mockRecordImport }));
vi.mock("@/lib/dtcm-pool", () => ({ importDtcmCodes: mockImportDtcmCodes }));

import { POST } from "@/app/api/events/[eventId]/import/barcodes/route";

const params = Promise.resolve({ eventId: "ev1" });

const req = (csv: string, mode?: string) =>
  ({
    formData: async () => ({
      get: (k: string) =>
        k === "file"
          ? ({ text: async () => csv } as unknown as File)
          : k === "mode"
            ? (mode ?? null)
            : null,
    }),
    url: "http://x/api/events/ev1/import/barcodes",
    headers: new Headers(),
  }) as unknown as Request;

/** Codes with no owner column at all — the leftover block from DTCM. */
const SPARES_CSV = "barcode\nDTCM-A\nDTCM-B\nDTCM-C";
/** The trap: the owner column exists but under a header we do not recognise. */
const MISTYPED_OWNER_CSV = "attendee_email,barcode\ndr@x.com,DTCM-A\ndr2@x.com,DTCM-B";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: "u1", role: "ADMIN", organizationId: "org1", firstName: "A" },
  });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", requiresDtcmBarcode: true });
  mockImportDtcmCodes.mockResolvedValue({ imported: 3, duplicates: 0 });
});

describe("spares mode — the pool can finally be filled", () => {
  it("accepts a barcode-only file and sends every code to the pool", async () => {
    const res = await POST(req(SPARES_CSV, "spares"), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 0, pooled: 3, poolDuplicates: 0 });
    expect(mockImportDtcmCodes).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "ev1",
        organizationId: "org1",
        codes: ["DTCM-A", "DTCM-B", "DTCM-C"],
      }),
    );
    // Nothing was assigned, so no registration was touched.
    expect(mockDb.registration.update).not.toHaveBeenCalled();
  });

  it("still assigns rows that DO name someone", async () => {
    // The mode relaxes the COLUMN requirement, not the row rule. A row naming a
    // person is more specific than the mode, so it wins.
    mockDb.registration.findFirst
      .mockResolvedValueOnce({ id: "r1", dtcmBarcode: null }) // lookup by email
      .mockResolvedValueOnce(null); // duplicate-barcode pre-check
    mockImportDtcmCodes.mockResolvedValue({ imported: 1, duplicates: 0 });

    const res = await POST(req("email,barcode\ndr@x.com,DTCM-A\n,DTCM-SPARE", "spares"), { params });

    expect(await res.json()).toMatchObject({ imported: 1, pooled: 1 });
    expect(mockImportDtcmCodes).toHaveBeenCalledWith(
      expect.objectContaining({ codes: ["DTCM-SPARE"] }),
    );
  });
});

describe("assign mode — a mistyped owner header must NOT become spares", () => {
  it("rejects a file with no recognised owner column", async () => {
    const res = await POST(req(MISTYPED_OWNER_CSV, "assign"), { params });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_OWNER_COLUMN");
    // Nothing pooled, nothing assigned — the file is refused whole.
    expect(mockImportDtcmCodes).not.toHaveBeenCalled();
    expect(mockDb.registration.update).not.toHaveBeenCalled();
  });

  it("names the columns it found and the way out", async () => {
    // A dead-end 400 sends the operator to support. This one is self-service.
    const body = await (await POST(req(MISTYPED_OWNER_CSV, "assign"), { params })).json();
    expect(body.error).toContain("attendee_email");
    expect(body.error).toContain("Spare codes for the desk");
  });

  it("defaults to assign when the client sends no mode at all", async () => {
    // The safe default: an older client, or a hand-rolled request, gets the
    // strict behaviour rather than the permissive one.
    const res = await POST(req(SPARES_CSV), { params });
    expect(res.status).toBe(400);
    expect(mockImportDtcmCodes).not.toHaveBeenCalled();
  });

  it("treats any unrecognised mode value as assign", async () => {
    const res = await POST(req(SPARES_CSV, "SPARES"), { params });
    expect(res.status).toBe(400);
  });

  it("still pools ownerless rows inside an ordinary assignment file", async () => {
    // Unchanged behaviour, pinned so the mode work did not quietly remove it.
    mockDb.registration.findFirst
      .mockResolvedValueOnce({ id: "r1", dtcmBarcode: null })
      .mockResolvedValueOnce(null);
    mockImportDtcmCodes.mockResolvedValue({ imported: 1, duplicates: 0 });

    const res = await POST(req("email,barcode\ndr@x.com,DTCM-A\n,DTCM-LEFTOVER", "assign"), { params });

    expect(await res.json()).toMatchObject({ imported: 1, pooled: 1 });
  });

  it("a row naming an owner we cannot find is an ERROR, never a spare", async () => {
    // The distinction the whole design rests on: "no owner value" is a spare,
    // "an owner we could not resolve" is a mistake worth reporting. Quietly
    // pooling it would leave a named person with no code and no warning.
    mockDb.registration.findFirst.mockResolvedValue(null);

    const body = await (
      await POST(req("email,barcode\nghost@x.com,DTCM-A", "assign"), { params })
    ).json();

    expect(body.imported).toBe(0);
    expect(body.pooled).toBe(0);
    expect(body.errors[0]).toContain("ghost@x.com");
    expect(mockImportDtcmCodes).not.toHaveBeenCalled();
  });
});

describe("the gates around it still hold", () => {
  it("refuses a non-Dubai event before reading the file", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", requiresDtcmBarcode: false });
    const res = await POST(req(SPARES_CSV, "spares"), { params });
    expect(res.status).toBe(400);
    expect(mockImportDtcmCodes).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(req(SPARES_CSV, "spares"), { params })).status).toBe(401);
  });

  it("400s a file with no barcode column in either mode", async () => {
    for (const mode of ["assign", "spares"]) {
      const res = await POST(req("email\ndr@x.com", mode), { params });
      expect(res.status).toBe(400);
    }
  });

  it("records the mode in the completion log", async () => {
    await POST(req(SPARES_CSV, "spares"), { params });
    expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ mode: "spares", pooled: 3 }));
  });
});
