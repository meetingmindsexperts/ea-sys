/** The purchase order's pure rules: labels, the second-person floor, when a request may become an order, the implied VAT rate. */
import { describe, it, expect } from "vitest";
import {
  COMMITMENT_STATUS_LABEL,
  FULFILLMENT_LABEL,
  RECEIPT_SECOND_PERSON_FLOOR_AED,
  impliedTaxRatePercent,
  orderReadiness,
  receiptNeedsSecondPerson,
} from "@/procurement/lib/commitment-rules";
import { SPEND_REQUEST_STATUS_LABEL } from "@/procurement/lib/spend-request-rules";

describe("labels", () => {
  it("names an issued order 'Issued' and a converted request 'Ordered', the words the owner uses", () => {
    expect(COMMITMENT_STATUS_LABEL.APPROVED).toBe("Issued");
    expect(SPEND_REQUEST_STATUS_LABEL.CONVERTED).toBe("Ordered");
    expect(FULFILLMENT_LABEL.OPEN).toBe("Not received");
    expect(FULFILLMENT_LABEL.PARTIALLY_RECEIVED).toBe("Partly received");
  });
});

describe("receiptNeedsSecondPerson (spec §6: from AED 50,000 a second person confirms)", () => {
  it("is false below the floor and true from the floor up", () => {
    expect(RECEIPT_SECOND_PERSON_FLOOR_AED.toString()).toBe("50000");
    expect(receiptNeedsSecondPerson("49999.99")).toBe(false);
    expect(receiptNeedsSecondPerson("50000")).toBe(true);
    expect(receiptNeedsSecondPerson("8400000.0000")).toBe(true);
  });
  it("fails CLOSED when the AED figure is unknown", () => {
    expect(receiptNeedsSecondPerson(null)).toBe(true);
    expect(receiptNeedsSecondPerson(undefined)).toBe(true);
  });
});

describe("orderReadiness", () => {
  const approved = { approvalStatus: "APPROVED", isActive: true };
  it("is ready for an approved request with an approved, active supplier and no order", () => {
    expect(orderReadiness({ status: "APPROVED", linkedCommitmentId: null, supplier: approved })).toEqual({ ready: true });
    expect(orderReadiness({ status: "AWAITING_SUPPLIER", linkedCommitmentId: null, supplier: approved })).toEqual({ ready: true });
  });
  it("names why not: already ordered, wrong status, supplier not approved or inactive", () => {
    expect(orderReadiness({ status: "APPROVED", linkedCommitmentId: "c1", supplier: approved })).toEqual({ ready: false, reason: "already-ordered" });
    expect(orderReadiness({ status: "DRAFT", linkedCommitmentId: null, supplier: approved })).toEqual({ ready: false, reason: "status" });
    expect(orderReadiness({ status: "CONVERTED", linkedCommitmentId: null, supplier: approved })).toEqual({ ready: false, reason: "status" });
    expect(orderReadiness({ status: "APPROVED", linkedCommitmentId: null, supplier: { approvalStatus: "PROPOSED", isActive: true } })).toEqual({ ready: false, reason: "supplier" });
    expect(orderReadiness({ status: "APPROVED", linkedCommitmentId: null, supplier: { approvalStatus: "APPROVED", isActive: false } })).toEqual({ ready: false, reason: "supplier" });
    expect(orderReadiness({ status: "APPROVED", linkedCommitmentId: null, supplier: null })).toEqual({ ready: false, reason: "supplier" });
  });
});

describe("impliedTaxRatePercent", () => {
  it("reads the percentage the stored pair implies, to two places, and null with no tax", () => {
    expect(impliedTaxRatePercent("1000", "50")).toBe(5);
    expect(impliedTaxRatePercent("36000", "1800")).toBe(5);
    expect(impliedTaxRatePercent("300", "10")).toBe(3.33);
    expect(impliedTaxRatePercent("1000", "0")).toBeNull();
    expect(impliedTaxRatePercent("0", "5")).toBeNull();
  });
});
