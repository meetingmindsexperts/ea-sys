/**
 * Entry-barcode visibility (check-in review H6/H7/H8). qrCode + dtcmBarcode are
 * physical-access credentials. The boundary is its OWN thing, NOT finance:
 * MEMBER + ONSITE are both finance-capable, but MEMBER must NOT see the
 * barcode (sponsor-side observer) while ONSITE MUST (desk staff print badges).
 */
import { describe, it, expect } from "vitest";
import { canViewEntryBarcode, redactBarcodeFields, BARCODE_KEYS } from "@/lib/barcode-visibility";

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
