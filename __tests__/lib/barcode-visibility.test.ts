/**
 * Entry-barcode visibility (check-in review H6/H7/H8). qrCode + dtcmBarcode are
 * physical-access credentials. The boundary is its OWN thing, NOT finance:
 * MEMBER + ONSITE are both finance-capable, but MEMBER must NOT see the
 * barcode (sponsor-side observer) while ONSITE MUST (desk staff print badges).
 */
import { describe, it, expect } from "vitest";
import { dtcmCodeWriteRefusal, redactBarcodeFields, registrationForCaller, BARCODE_KEYS } from "@/lib/barcode-visibility";
import { canViewEntryBarcode } from "../helpers/role-can";

describe("canViewEntryBarcode", () => {
  it.each(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "ONSITE"])("allows the door/badge role %s", (role) => {
    expect(canViewEntryBarcode(role)).toBe(true);
  });

  it("DENIES MEMBER even though MEMBER is finance-capable (the key divergence)", () => {
    expect(canViewEntryBarcode("MEMBER")).toBe(false);
  });

  it.each(["REGISTRANT", "REVIEWER", "SUBMITTER"])("denies the non-desk role %s", (role) => {
    expect(canViewEntryBarcode(role)).toBe(false);
  });

  it("fails closed for unknown / missing roles", () => {
    expect(canViewEntryBarcode(null)).toBe(false);
    expect(canViewEntryBarcode(undefined)).toBe(false);
    expect(canViewEntryBarcode("")).toBe(false);
  });

  it("treats API-key callers as admin-equivalent", () => {
    expect(canViewEntryBarcode(null, true)).toBe(true);
  });
});

describe("redactBarcodeFields", () => {
  const reg = () => ({
    id: "r1",
    status: "CONFIRMED",
    qrCode: "ENTRY-SECRET",
    dtcmBarcode: "DTCM-123",
    attendee: { firstName: "A", lastName: "B", email: "a@b.com" },
    payments: [{ id: "p1", amount: 100 }],
  });

  it("drops both barcode keys, keeps everything else including nested objects", () => {
    const out = redactBarcodeFields(reg());
    expect("qrCode" in out).toBe(false);
    expect("dtcmBarcode" in out).toBe(false);
    expect(out.id).toBe("r1");
    expect(out.attendee).toEqual({ firstName: "A", lastName: "B", email: "a@b.com" });
    expect(out.payments).toEqual([{ id: "p1", amount: 100 }]);
  });

  it("redacts every row of a list", () => {
    const out = redactBarcodeFields([reg(), reg()]);
    for (const r of out) {
      expect("qrCode" in r).toBe(false);
      expect("dtcmBarcode" in r).toBe(false);
    }
  });

  it("passes non-objects through untouched", () => {
    expect(redactBarcodeFields(null)).toBeNull();
    expect(redactBarcodeFields("x")).toBe("x");
  });

  it("covers exactly the documented credential keys", () => {
    expect([...BARCODE_KEYS].sort()).toEqual(["dtcmBarcode", "qrCode"]);
  });
});

describe("registrationForCaller", () => {
  const row = { id: "r1", qrCode: "ENTRY", dtcmBarcode: "DTCM", attendee: { firstName: "A" } };

  it("is the row itself for someone who may hold a door credential", () => {
    expect(registrationForCaller(true, row)).toBe(row);
  });

  it("drops both codes for anyone else, wherever the row sits in the answer", () => {
    expect(registrationForCaller(false, row)).toEqual({ id: "r1", attendee: { firstName: "A" } });
    expect(registrationForCaller(false, { code: "ALREADY_CHECKED_IN", registration: row })).toEqual({ code: "ALREADY_CHECKED_IN", registration: { id: "r1", attendee: { firstName: "A" } } });
    expect(registrationForCaller(false, [row])).toEqual([{ id: "r1", attendee: { firstName: "A" } }]);
  });
});

/** What the registration save does with a `dtcmBarcode` in its request. */
describe("dtcmCodeWriteRefusal", () => {
  it("nothing to do when the field is not sent, whoever sends the request", () => {
    expect(dtcmCodeWriteRefusal({ sent: undefined, mayWrite: false, storedCode: "X" })).toEqual({ action: "allow" });
    expect(dtcmCodeWriteRefusal({ sent: undefined, mayWrite: true, storedCode: null })).toEqual({ action: "allow" });
  });

  it("someone who may write it sets, replaces and clears", () => {
    for (const sent of ["NEW", "", null]) {
      expect(dtcmCodeWriteRefusal({ sent, mayWrite: true, storedCode: "OLD" })).toEqual({ action: "allow" });
    }
  });

  it("a value from someone who may not is refused", () => {
    expect(dtcmCodeWriteRefusal({ sent: "NEW", mayWrite: false, storedCode: null })).toEqual({ action: "refuse" });
    expect(dtcmCodeWriteRefusal({ sent: "NEW", mayWrite: false, storedCode: "OLD" })).toEqual({ action: "refuse" });
  });

  it("a blank from someone who may not is dropped, and says whether it would have wiped a code", () => {
    expect(dtcmCodeWriteRefusal({ sent: null, mayWrite: false, storedCode: "OLD" })).toEqual({ action: "drop", wouldHaveCleared: true });
    expect(dtcmCodeWriteRefusal({ sent: "", mayWrite: false, storedCode: "OLD" })).toEqual({ action: "drop", wouldHaveCleared: true });
    expect(dtcmCodeWriteRefusal({ sent: "   ", mayWrite: false, storedCode: null })).toEqual({ action: "drop", wouldHaveCleared: false });
  });

  it("never answers differently for a right guess: the stored code is not compared with what was sent", () => {
    const right = dtcmCodeWriteRefusal({ sent: "OLD", mayWrite: false, storedCode: "OLD" });
    const wrong = dtcmCodeWriteRefusal({ sent: "NOPE", mayWrite: false, storedCode: "OLD" });
    expect(right).toEqual(wrong);
  });
});
