/**
 * The entry barcode and the DTCM code are door credentials, held only with
 * `barcode.view` (a MEMBER runs the desk and does not have it). The list and
 * the detail read have stripped them since July 2026; these are the answers
 * and the one write that did not (review of 243b7136, Nov 11, 2026):
 *
 *   - the registration save answered with the whole row,
 *   - the create answered with the new row,
 *   - check-in (by id, by scan, the "already checked in" refusal, the undo)
 *     answered with the row,
 *   - and the save took a `dtcmBarcode` from anyone who could save. The sheet
 *     sent a blank for it on every save, so a MEMBER's edit wiped the code.
 *
 * The permission module is REAL here: the roles' own grants decide.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockUpdate, mockCreate, mockExecute, mockUndo, mockGate, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn(), findMany: vi.fn() },
    invoice: { aggregate: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockUpdate: vi.fn(),
  mockCreate: vi.fn(),
  mockExecute: vi.fn(),
  mockUndo: vi.fn(),
  mockGate: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_org: unknown, _ctx: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockReturnValue({ catch: () => {} }) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/speaker-companion", () => ({ ensureFacultyTicketType: vi.fn() }));
vi.mock("@/lib/sponsors", () => ({ getSponsors: vi.fn(async () => []), getSponsorNameMap: vi.fn(async () => new Map()), sponsorExistsOnEvent: vi.fn(async () => false) }));
vi.mock("@/services/registration-service", async () => ({
  ...(await vi.importActual<object>("@/services/registration-service")),
  updateRegistration: (a: unknown) => mockUpdate(a),
  createRegistration: (a: unknown) => mockCreate(a),
}));
vi.mock("@/lib/check-in", () => ({
  checkInGate: (...a: unknown[]) => mockGate(...a),
  executeCheckIn: (a: unknown) => mockExecute(a),
  undoCheckIn: (a: unknown) => mockUndo(a),
  CheckInCancelledError: class extends Error {},
}));

import { PUT as SAVE } from "@/app/api/events/[eventId]/registrations/[registrationId]/route";
import { POST as CREATE } from "@/app/api/events/[eventId]/registrations/route";
import { POST as CHECK_IN, PUT as SCAN, DELETE as UNDO } from "@/app/api/events/[eventId]/registrations/[registrationId]/check-in/route";

const NOW = "2026-11-11T10:00:00.000Z";
const one = { params: Promise.resolve({ eventId: "ev1", registrationId: "reg1" }) };
const ROW = {
  id: "reg1", eventId: "ev1", status: "CONFIRMED", paymentStatus: "COMPLIMENTARY", attendanceMode: "IN_PERSON",
  qrCode: "ENTRY-SECRET", dtcmBarcode: "DTCM-SECRET", originalPrice: 0, discountAmount: null, refundedAmount: 0, payments: [],
  attendee: { firstName: "Hajar", lastName: "Almaqbali", email: "hajar@example.com" }, ticketType: { name: "Physician", price: 0, currency: "USD" }, pricingTier: null,
};
// What `can()` judges an event-scoped key by: the organisation, the type and the assigned desk staff.
const EVENT = { id: "ev1", settings: {}, taxRate: null, taxLabel: null, organizationId: "org1", eventType: "CONFERENCE", staffAssignments: [{ userId: "onsite1" }] };

// `keys` are a custom role's grants as the session carries them, beside the base role's: `key` for an
// organisation key, `key@SCOPE` for an event one (an event key with no scope reaches no event).
const as = (role: string, id = "u1", keys: string[] = []) =>
  mockAuth.mockResolvedValue({ user: { id, role, organizationId: "org1", firstName: "Desk", procurementPermissions: keys } });
const save = (body: Record<string, unknown>) =>
  SAVE(new Request("http://x", { method: "PUT", body: JSON.stringify({ expectedUpdatedAt: NOW, ...body }) }), one);
const hasCodes = (body: Record<string, unknown>) => "qrCode" in body || "dtcmBarcode" in body;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.registration.findFirst.mockResolvedValue({ ...ROW });
  mockDb.registration.findMany.mockResolvedValue([{ ...ROW }]);
  mockDb.invoice.aggregate.mockResolvedValue({ _sum: { total: null } });
  mockUpdate.mockResolvedValue({ ok: true, registration: { ...ROW }, qrCodeMinted: false });
  mockCreate.mockResolvedValue({ ok: true, registration: { ...ROW }, dtcm: { status: "assigned", code: "DTCM-SECRET" } });
  mockExecute.mockResolvedValue({ ...ROW, status: "CHECKED_IN" });
  mockUndo.mockResolvedValue({ ok: true, registration: { ...ROW } });
  mockGate.mockReturnValue(null);
});

describe("the save's answer", () => {
  it("carries no entry barcode and no DTCM code for a MEMBER", async () => {
    as("MEMBER");
    const res = await save({ notes: "spelling fixed" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(hasCodes(body)).toBe(false);
    expect(body.attendee.firstName).toBe("Hajar");
  });

  it.each(["ADMIN", "ORGANIZER"])("keeps both for %s", async (role) => {
    as(role);
    const body = await (await save({ notes: "x" })).json();
    expect(body).toMatchObject({ qrCode: "ENTRY-SECRET", dtcmBarcode: "DTCM-SECRET" });
  });

  it("keeps both for Onsite Staff (they print the badge)", async () => {
    as("ONSITE", "onsite1");
    expect(await (await save({ notes: "x" })).json()).toMatchObject({ qrCode: "ENTRY-SECRET", dtcmBarcode: "DTCM-SECRET" });
  });
});

describe("writing the DTCM code through the save", () => {
  it("a MEMBER's blank is dropped, never applied: the edit saves and the stored code is left alone", async () => {
    as("MEMBER");
    // What the registration sheet sent on every save for a role that cannot see the code.
    const res = await save({ notes: "spelling fixed", dtcmBarcode: null });
    expect(res.status).toBe(200);
    const sent = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect("dtcmBarcode" in sent).toBe(false);
    expect(sent.notes).toBe("spelling fixed");
    // It would have wiped a code, so it is logged.
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registration-update:dtcm-blank-dropped", registrationId: "reg1" }));
  });

  it("the same blank on a registration with no code is dropped without a log line", async () => {
    as("MEMBER");
    mockDb.registration.findFirst.mockResolvedValueOnce({ ...ROW, dtcmBarcode: null });
    await save({ notes: "x", dtcmBarcode: "" });
    expect("dtcmBarcode" in (mockUpdate.mock.calls[0][0] as object)).toBe(false);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.objectContaining({ msg: "registration-update:dtcm-blank-dropped" }));
  });

  it("a MEMBER setting a code is refused, and nothing is saved", async () => {
    as("MEMBER");
    const res = await save({ notes: "x", dtcmBarcode: "MY-OWN-CODE" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "DTCM_CODE_FORBIDDEN" });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registration-update:dtcm-code-forbidden" }));
  });

  it("the refusal does not depend on the stored code: a right guess is refused like a wrong one", async () => {
    as("MEMBER");
    expect((await save({ dtcmBarcode: "DTCM-SECRET" })).status).toBe(403);
    expect((await save({ dtcmBarcode: "NOT-IT" })).status).toBe(403);
  });

  it.each(["ADMIN", "ORGANIZER"])("%s sets and clears it as before", async (role) => {
    as(role);
    await save({ dtcmBarcode: "TYPED-BY-HAND" });
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({ dtcmBarcode: "TYPED-BY-HAND" });
    await save({ dtcmBarcode: null });
    expect(mockUpdate.mock.calls[1][0]).toMatchObject({ dtcmBarcode: null });
  });

  it("Onsite Staff on their own event may put a code on (the desk's Use this code)", async () => {
    as("ONSITE", "onsite1");
    expect((await save({ dtcmBarcode: "FROM-A-DET-SALE" })).status).toBe(200);
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({ dtcmBarcode: "FROM-A-DET-SALE" });
  });

  // The rule is BOTH keys, and `dtcm.assign` on THIS event. Every caller above
  // holds both or neither, so these are what pin its shape (review of c9fa26c1).
  describe("one key without the other", () => {
    it("seeing codes is not being allowed to assign one: a new value and a clear are both refused", async () => {
      as("MEMBER", "u1", ["barcode.view"]);
      expect((await save({ dtcmBarcode: "TYPED" })).status).toBe(403);
      // Their clear is deliberate (they can see the code), so it is refused, not quietly dropped.
      const cleared = await save({ notes: "x", dtcmBarcode: null });
      expect(cleared.status).toBe(403);
      expect(await cleared.json()).toMatchObject({ code: "DTCM_CODE_FORBIDDEN" });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("their form sending back the code it loaded is no change: the edit saves, the field is dropped", async () => {
      as("MEMBER", "u1", ["barcode.view"]);
      const res = await save({ notes: "spelling fixed", dtcmBarcode: "DTCM-SECRET" });
      expect(res.status).toBe(200);
      expect("dtcmBarcode" in (mockUpdate.mock.calls[0][0] as object)).toBe(false);
      // They can see codes, so the answer keeps them.
      expect(await res.json()).toMatchObject({ dtcmBarcode: "DTCM-SECRET" });
    });

    it("being allowed to assign is not seeing: without `barcode.view` a value is still refused", async () => {
      as("MEMBER", "u1", ["dtcm.assign@ALL"]);
      expect((await save({ dtcmBarcode: "TYPED" })).status).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("both keys from a custom role are enough", async () => {
      as("MEMBER", "u1", ["barcode.view", "dtcm.assign@ALL"]);
      expect((await save({ dtcmBarcode: "TYPED" })).status).toBe(200);
      expect(mockUpdate.mock.calls[0][0]).toMatchObject({ dtcmBarcode: "TYPED" });
    });

    it("`dtcm.assign` is judged on THIS event: Onsite Staff not assigned to it may not write a code", async () => {
      // The real route answers 404 before this (the event lookup is the grant's own filter, which the
      // mock ignores). What is pinned here is that the code key is asked with the event's facts.
      as("ONSITE", "onsite-elsewhere");
      expect((await save({ dtcmBarcode: "FROM-A-DET-SALE" })).status).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
      as("ONSITE", "onsite1");
      expect((await save({ dtcmBarcode: "FROM-A-DET-SALE" })).status).toBe(200);
    });
  });

  it("a save that does not name the code is untouched by any of this", async () => {
    as("MEMBER");
    await save({ notes: "x" });
    expect("dtcmBarcode" in (mockUpdate.mock.calls[0][0] as object)).toBe(false);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe("the create's answer", () => {
  const create = () =>
    CREATE(new Request("http://x", { method: "POST", body: JSON.stringify({ ticketTypeId: "ckv9p2q3r0000abcdefghijkl", attendee: { email: "hajar@example.com", firstName: "Hajar", lastName: "Almaqbali" } }) }), {
      params: Promise.resolve({ eventId: "ev1" }),
    });

  it("strips both codes for a MEMBER, and still says whether a DTCM code was assigned", async () => {
    as("MEMBER");
    const res = await create();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(hasCodes(body)).toBe(false);
    expect(body.hasDtcmCode).toBe(true);
  });

  it("says so when none was assigned", async () => {
    as("MEMBER");
    mockCreate.mockResolvedValueOnce({ ok: true, registration: { ...ROW, dtcmBarcode: null }, dtcm: { status: "pool-empty" } });
    expect((await (await create()).json()).hasDtcmCode).toBe(false);
  });

  it("keeps both for an organiser", async () => {
    as("ORGANIZER");
    expect(await (await create()).json()).toMatchObject({ qrCode: "ENTRY-SECRET", dtcmBarcode: "DTCM-SECRET", hasDtcmCode: true });
  });
});

describe("the check-in answers", () => {
  const byId = () => CHECK_IN(new Request("http://x", { method: "POST" }), one);
  const scan = () => SCAN(new Request("http://x", { method: "PUT", body: JSON.stringify({ qrCode: "ENTRY-SECRET" }) }), one);
  const undo = () => UNDO(new Request("http://x", { method: "DELETE" }), one);

  it("check in, scan and undo strip both codes for a MEMBER", async () => {
    as("MEMBER");
    for (const call of [byId, scan, undo]) {
      const res = await call();
      expect(res.status).toBe(200);
      expect(hasCodes(await res.json())).toBe(false);
    }
  });

  it("the 'already checked in' refusal, which names the person, strips them too", async () => {
    as("MEMBER");
    mockGate.mockReturnValue({ code: "ALREADY_CHECKED_IN", message: "Already checked in", checkedInAt: NOW });
    const body = await (await scan()).json();
    expect(body.code).toBe("ALREADY_CHECKED_IN");
    // The desk reads who it was from here.
    expect(body.registration.attendee.email).toBe("hajar@example.com");
    expect(hasCodes(body.registration)).toBe(false);
  });

  it("Onsite Staff keep them on all four", async () => {
    as("ONSITE", "onsite1");
    for (const call of [byId, scan, undo]) expect(await (await call()).json()).toMatchObject({ qrCode: "ENTRY-SECRET" });
    mockGate.mockReturnValue({ code: "ALREADY_CHECKED_IN", message: "Already checked in", checkedInAt: NOW });
    expect((await (await scan()).json()).registration).toMatchObject({ qrCode: "ENTRY-SECRET", dtcmBarcode: "DTCM-SECRET" });
  });
});
