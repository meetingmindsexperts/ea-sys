/**
 * The SERVER-SIDE supporting-document gate, on the real public register route.
 *
 * This is the enforcement point: the form is a courtesy, this is what a crafted
 * POST hits. It had no coverage at all until Aug 14, 2026 — the shipped tests
 * were all pure-helper or organizer-write-path, i.e. everything except the
 * thing that actually refuses a registration.
 *
 * It is also the ONLY layer where "a rename must not change behaviour" is
 * assertable, because it is the only one where a type NAME exists. The helper
 * takes a policy object and has no name parameter, so the three cases that used
 * to claim this in supporting-document.test.ts could not fail. They live here
 * now, against a type literally called "Resident".
 *
 * Four behaviours are pinned, and the two DROP cases matter most because both
 * are silent by design — nothing is returned to the caller, so without a test
 * the only evidence they work is reading the code.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockTenantTransaction } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    ticketType: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  // Sentinel: reaching the transaction means the gate ALLOWED the registration.
  // Throwing here keeps the test focused on the gate instead of mocking the
  // whole create path, and gives an unmistakable signal either way.
  mockTenantTransaction: vi.fn(async () => {
    throw new Error("__REACHED_TRANSACTION__");
  }),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: { set: vi.fn() },
    }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb, tenantTransaction: mockTenantTransaction }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere: vi.fn(async () => ({})) }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/utils", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateBarcode: () => "BC123",
}));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: vi.fn(async () => 1) }));
vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: vi.fn() }));
vi.mock("@/lib/webinar-email-sequence", () => ({ sendWebinarConfirmationForRegistration: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/registrant-account", () => ({ ensureRegistrantAccount: vi.fn() }));
vi.mock("@/lib/registration-seat-db", () => ({ claimEventSeats: vi.fn(async () => true) }));
vi.mock("@/lib/registration-confirmation", () => ({ buildEventConfirmationFields: () => ({}) }));

import { POST } from "@/app/api/public/events/[slug]/register/route";

const EVENT_ID = "evt-1";
const DOC_PREFIX = "/uploads/resident-letters";
const VALID_PATH = `${DOC_PREFIX}/${EVENT_ID}/3f8b21ca-9d44-4e11-8a20-1f0b7c6d5e33.pdf`;

const params = Promise.resolve({ slug: "my-event" });

/** A minimally-valid body; the schema requires the full public field set. */
function body(extra: Record<string, unknown> = {}) {
  return {
    ticketTypeId: "tt-1",
    title: "DR",
    role: "PHYSICIAN",
    firstName: "Ahmed",
    lastName: "Osman",
    email: "ahmed@hospital.org",
    organization: "Tawam Hospital",
    jobTitle: "Resident",
    phone: "+971500000000",
    city: "Al Ain",
    country: "United Arab Emirates",
    specialty: "Cardiology",
    ...extra,
  };
}

function request(extra: Record<string, unknown> = {}) {
  return new Request("http://t", { method: "POST", body: JSON.stringify(body(extra)) });
}

/** Runs the route and reports what the gate decided. */
async function run(ticketType: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  mockDb.ticketType.findFirst.mockResolvedValue({
    id: "tt-1",
    name: "Resident",
    price: 0,
    currency: "USD",
    quantity: 999999,
    soldCount: 0,
    isFaculty: false,
    requiresApproval: false,
    ...ticketType,
  });
  let status: number | undefined;
  let payload: { code?: string } | undefined;
  let reachedTransaction = false;
  try {
    const res = await POST(request(extra), { params });
    status = res.status;
    payload = await res.json();
  } catch (err) {
    if ((err as Error).message === "__REACHED_TRANSACTION__") reachedTransaction = true;
    else throw err;
  }
  // The route wraps its body in try/catch, so a thrown sentinel surfaces as a
  // 500 rather than propagating — check both signals.
  if (status === 500) reachedTransaction = true;
  return { status, code: payload?.code, reachedTransaction };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantTransaction.mockImplementation(async () => {
    throw new Error("__REACHED_TRANSACTION__");
  });
  mockDb.event.findFirst.mockResolvedValue({
    id: EVENT_ID,
    slug: "my-event",
    name: "Test Event",
    status: "PUBLISHED",
    eventType: "CONFERENCE",
    organizationId: "org-1",
    settings: {},
    maxAttendees: null,
    seatCount: 0,
    startDate: new Date("2026-10-02T04:00:00Z"),
    endDate: new Date("2026-10-03T14:00:00Z"),
    timezone: "Asia/Dubai",
    taxRate: null,
    ticketTypes: [],
  });
  mockDb.registration.findFirst.mockResolvedValue(null);
});

describe("supporting-document gate — Required", () => {
  it("refuses the registration when the document is missing", async () => {
    const r = await run({ requiresDocument: true, documentRequired: true, documentLabel: "Official Letter" });
    expect(r.status).toBe(400);
    expect(r.code).toBe("SUPPORTING_DOCUMENT_REQUIRED");
    expect(r.reachedTransaction).toBe(false);
  });

  it("names the organizer's own label in the refusal", async () => {
    // Someone asked for a card should not be told they are missing a letter.
    //
    // The type is called "Society Affiliate" and NOT "Member" on purpose: the
    // older member/student evidence rules are still name-matched, so a type
    // named "Member" demands a Member ID and 400s on THAT before the document
    // gate is reached. This test found that by failing, which is a fair
    // reminder that the surviving name-matched rules can still shadow the new
    // per-type one (docs/PER_TYPE_DOCUMENT_UPLOAD_PLAN.md §4 leaves them
    // name-matched deliberately).
    mockDb.ticketType.findFirst.mockResolvedValue({
      id: "tt-1", name: "Society Affiliate", price: 0, currency: "USD", quantity: 999999,
      soldCount: 0, isFaculty: false, requiresApproval: false,
      requiresDocument: true, documentRequired: true, documentLabel: "Membership Card",
    });
    const res = await POST(request(), { params });
    const payload = (await res.json()) as { error: string };
    expect(res.status).toBe(400);
    expect(payload.error).toContain("Membership Card");
  });

  it("proceeds once a valid document path is supplied", async () => {
    const r = await run(
      { requiresDocument: true, documentRequired: true },
      { supportingDocumentUrl: VALID_PATH, supportingDocumentFilename: "letter.pdf" },
    );
    expect(r.code).not.toBe("SUPPORTING_DOCUMENT_REQUIRED");
    expect(r.reachedTransaction).toBe(true);
  });
});

describe("supporting-document gate — Optional", () => {
  it("admits a registrant with no document", async () => {
    // The default, and the reason the two booleans are separate: the field is
    // shown and collected, but somebody without the file to hand still gets in.
    const r = await run({ requiresDocument: true, documentRequired: false });
    expect(r.code).not.toBe("SUPPORTING_DOCUMENT_REQUIRED");
    expect(r.reachedTransaction).toBe(true);
  });
});

describe("a type NAME no longer decides anything", () => {
  // The defect the whole change exists to fix, assertable only here because
  // this is the only layer where a name is in play.
  it('a type called "Resident" with the box unticked asks for nothing', async () => {
    const r = await run({ name: "Resident", requiresDocument: false, documentRequired: false });
    expect(r.code).not.toBe("SUPPORTING_DOCUMENT_REQUIRED");
    expect(r.reachedTransaction).toBe(true);
  });

  it('a type renamed to "Junior Doctor" keeps blocking while the box is ticked', async () => {
    // Under the old mechanism this rename silently switched the requirement
    // off, with no warning and no log line.
    const r = await run({ name: "Junior Doctor", requiresDocument: true, documentRequired: true });
    expect(r.status).toBe(400);
    expect(r.code).toBe("SUPPORTING_DOCUMENT_REQUIRED");
  });
});

describe("silent drops are logged", () => {
  it("a malformed path is dropped, not 400'd, and logged", async () => {
    // Dropping rather than refusing is deliberate: a malformed value can only
    // come from a tampered request, and failing the whole registration would
    // punish the honest case where a proxy mangled the field.
    const r = await run(
      { requiresDocument: true, documentRequired: false },
      { supportingDocumentUrl: "/uploads/speaker-docs/evt/passport.pdf" },
    );
    expect(r.status).not.toBe(400);
    expect(r.reachedTransaction).toBe(true);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "public/register:supporting-document-path-rejected" }),
    );
  });

  it("a path for ANOTHER event is rejected, not stored", async () => {
    // Shape alone is not ownership: without the event binding, an anonymous
    // POST could point this registration at another event's (on the platform,
    // another tenant's) file, which that event's staff would then stream.
    const r = await run(
      { requiresDocument: true, documentRequired: false },
      { supportingDocumentUrl: `${DOC_PREFIX}/some-other-event/3f8b21ca-9d44-4e11-8a20-1f0b7c6d5e33.pdf` },
    );
    expect(r.reachedTransaction).toBe(true);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "public/register:supporting-document-path-rejected" }),
    );
  });

  it("a document sent for a type that is not asking is dropped WITH a log", async () => {
    // The registrant uploaded, then changed their registration type. This was
    // the one drop in the flow with no log at all, so an organizer chasing
    // "they said they uploaded it" had nothing to find.
    const r = await run(
      { requiresDocument: false, documentRequired: false },
      { supportingDocumentUrl: VALID_PATH },
    );
    expect(r.reachedTransaction).toBe(true);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "public/register:supporting-document-dropped-type-not-asking",
      }),
    );
  });
});

describe("pre-rename browser bundles keep working", () => {
  it("accepts the legacy residentLetterUrl field and logs that it was used", async () => {
    // A registrant holding the pre-Aug-13 bundle posts the old field names.
    // Zod strips unknown keys, so before the alias the path was discarded
    // silently — no log, no document, and the file pruned 24h later.
    const r = await run(
      { requiresDocument: true, documentRequired: true },
      { residentLetterUrl: VALID_PATH, residentLetterFilename: "letter.pdf" },
    );
    expect(r.code).not.toBe("SUPPORTING_DOCUMENT_REQUIRED");
    expect(r.reachedTransaction).toBe(true);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "public/register:legacy-document-field-used" }),
    );
  });
});
