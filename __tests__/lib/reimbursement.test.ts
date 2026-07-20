/**
 * Speaker reimbursement — pure-lib tests: per-currency totals, the paper
 * form's receipt rule (requiredDocumentKinds/missingDocumentKinds), the
 * staff-only access predicate, and the submit schema's guardrails.
 */
import { describe, it, expect } from "vitest";
import {
  canManageReimbursements,
  computeClaimTotals,
  formatClaimTotals,
  missingDocumentKinds,
  requiredDocumentKinds,
  reimbursementSubmitSchema,
  type ClaimLine,
} from "@/lib/reimbursement/constants";

const line = (item: ClaimLine["item"], currency: ClaimLine["currency"], amount: number): ClaimLine => ({
  item,
  currency,
  amount,
});

describe("computeClaimTotals", () => {
  it("sums a single currency", () => {
    expect(computeClaimTotals([line("SPEAKER_FEE", "USD", 1000), line("FLIGHT", "USD", 850.5)])).toEqual({
      USD: 1850.5,
    });
  });

  it("keeps currencies separate — never sums across them", () => {
    expect(computeClaimTotals([line("SPEAKER_FEE", "USD", 1000), line("HOTEL", "AED", 400)])).toEqual({
      USD: 1000,
      AED: 400,
    });
  });

  it("rounds to 2dp", () => {
    expect(computeClaimTotals([line("FLIGHT", "USD", 0.1), line("HOTEL", "USD", 0.2)])).toEqual({
      USD: 0.3,
    });
  });

  it("formats mixed currencies in canonical order", () => {
    expect(formatClaimTotals([line("HOTEL", "SAR", 500), line("SPEAKER_FEE", "USD", 1000)])).toBe(
      "USD 1,000.00 · SAR 500.00",
    );
  });
});

describe("requiredDocumentKinds — the receipt rule", () => {
  it("always requires the passport copy", () => {
    expect(requiredDocumentKinds([line("SPEAKER_FEE", "USD", 1000)])).toEqual(["PASSPORT"]);
  });

  it("maps each claimed expense to its receipt kind", () => {
    const kinds = requiredDocumentKinds([
      line("FLIGHT", "USD", 850),
      line("HOTEL", "USD", 400),
      line("TRANSPORT", "USD", 50),
      line("OTHER", "USD", 20),
    ]);
    expect(kinds).toEqual(
      expect.arrayContaining(["PASSPORT", "FLIGHT_RECEIPT", "HOTEL_INVOICE", "TRANSPORT_RECEIPT", "OTHER"]),
    );
    expect(kinds).toHaveLength(5);
  });

  it("missingDocumentKinds reports only uncovered kinds", () => {
    const lines = [line("FLIGHT", "USD", 850), line("HOTEL", "USD", 400)];
    expect(missingDocumentKinds(lines, ["PASSPORT", "FLIGHT_RECEIPT"])).toEqual(["HOTEL_INVOICE"]);
    expect(missingDocumentKinds(lines, ["PASSPORT", "FLIGHT_RECEIPT", "HOTEL_INVOICE"])).toEqual([]);
  });
});

describe("canManageReimbursements — staff-only, fails closed", () => {
  it.each([
    ["SUPER_ADMIN", true],
    ["ADMIN", true],
    ["ORGANIZER", true],
    ["MEMBER", false],
    ["ONSITE", false],
    ["CRM_USER", false],
    ["REVIEWER", false],
    ["SUBMITTER", false],
    ["REGISTRANT", false],
  ] as const)("%s → %s", (role, expected) => {
    expect(canManageReimbursements(role)).toBe(expected);
  });

  it("fails closed on null/undefined/unknown", () => {
    expect(canManageReimbursements(null)).toBe(false);
    expect(canManageReimbursements(undefined)).toBe(false);
    expect(canManageReimbursements("SOME_FUTURE_ROLE")).toBe(false);
  });
});

describe("reimbursementSubmitSchema", () => {
  const valid = {
    fullName: "Jane Doe",
    country: "United States",
    email: "jane@example.com",
    nationality: "American",
    passportNumber: "P1234567",
    roleAtEvent: "Speaker",
    claimLines: [line("SPEAKER_FEE", "USD", 1000)],
    bankDetails: {
      beneficiaryName: "Jane Doe",
      bankName: "Chase Bank",
      swift: "CHASUS33",
      accountNumber: "12345678",
    },
    signedName: "Jane Doe",
    declarationAccepted: true as const,
  };

  it("accepts a valid submission", () => {
    expect(reimbursementSubmitSchema.safeParse(valid).success).toBe(true);
  });

  it("requires the declaration to be literally true", () => {
    expect(reimbursementSubmitSchema.safeParse({ ...valid, declarationAccepted: false }).success).toBe(false);
  });

  it("requires the wire-compliance fields", () => {
    for (const key of ["fullName", "passportNumber", "nationality", "country", "roleAtEvent", "signedName"]) {
      const parsed = reimbursementSubmitSchema.safeParse({ ...valid, [key]: "" });
      expect(parsed.success, `${key} should be required`).toBe(false);
    }
  });

  it("requires at least one claim line and rejects non-positive amounts", () => {
    expect(reimbursementSubmitSchema.safeParse({ ...valid, claimLines: [] }).success).toBe(false);
    expect(
      reimbursementSubmitSchema.safeParse({ ...valid, claimLines: [line("FLIGHT", "USD", -5)] }).success,
    ).toBe(false);
    expect(
      reimbursementSubmitSchema.safeParse({ ...valid, claimLines: [line("FLIGHT", "USD", 0)] }).success,
    ).toBe(false);
  });

  it("rejects a currency outside USD/AED/SAR", () => {
    expect(
      reimbursementSubmitSchema.safeParse({
        ...valid,
        claimLines: [{ item: "FLIGHT", currency: "EUR", amount: 100 }],
      }).success,
    ).toBe(false);
  });

  it("bank details need an account number OR an IBAN (either satisfies)", () => {
    const noAccount = {
      ...valid,
      bankDetails: { beneficiaryName: "Jane Doe", bankName: "Chase", swift: "CHASUS33" },
    };
    expect(reimbursementSubmitSchema.safeParse(noAccount).success).toBe(false);

    const ibanOnly = {
      ...valid,
      bankDetails: {
        beneficiaryName: "Jane Doe",
        bankName: "Emirates NBD",
        swift: "EBILAEAD",
        iban: "AE070331234567890123456",
      },
    };
    expect(reimbursementSubmitSchema.safeParse(ibanOnly).success).toBe(true);
  });

  it("bank details require beneficiary name, bank name and SWIFT", () => {
    for (const key of ["beneficiaryName", "bankName", "swift"]) {
      const parsed = reimbursementSubmitSchema.safeParse({
        ...valid,
        bankDetails: { ...valid.bankDetails, [key]: "" },
      });
      expect(parsed.success, `${key} should be required`).toBe(false);
    }
  });
});
