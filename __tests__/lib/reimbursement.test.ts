/**
 * Speaker reimbursement — pure-lib tests: per-currency totals, the paper
 * form's receipt rule (requiredDocumentKinds/missingDocumentKinds), the
 * staff-only access predicate, and the submit schema's guardrails.
 */
import { describe, it, expect } from "vitest";
import {
  CLAIM_ITEMS,
  canManageReimbursements,
  computeClaimTotals,
  effectiveClaimLines,
  formatClaimTotals,
  formatHonorarium,
  honorariumInputSchema,
  honorariumVars,
  missingDocumentKinds,
  readHonorarium,
  reimbursementSubmitSchema,
  requiredDocumentKinds,
  stripHonorariumFields,
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

  it("accepts an EMPTY expense list (the server decides emptiness after injecting the fee) and rejects non-positive amounts", () => {
    // Sep 3, 2026: a speaker with an agreed honorarium and no expenses sends
    // []. Emptiness is judged server-side over the effective lines
    // (NOTHING_TO_CLAIM), so the schema must not refuse it here.
    expect(reimbursementSubmitSchema.safeParse({ ...valid, claimLines: [] }).success).toBe(true);
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

// ── Honorarium / speaker fee (Sep 3, 2026) ────────────────────────────
describe("honorarium: organiser-set, locked, 0 when unset", () => {
  it("the claim item is labelled Honorarium / Speaker Fee", () => {
    expect(CLAIM_ITEMS.find((c) => c.key === "SPEAKER_FEE")?.label).toBe("Honorarium / Speaker Fee");
  });

  it("readHonorarium accepts a Prisma Decimal, its JSON string, or a number, and rounds to 2dp", () => {
    expect(readHonorarium({ honorariumAmount: { toString: () => "1500.005" }, honorariumCurrency: "USD" })).toEqual({
      amount: 1500.01,
      currency: "USD",
    });
    expect(readHonorarium({ honorariumAmount: "2500.5", honorariumCurrency: "AED" })).toEqual({
      amount: 2500.5,
      currency: "AED",
    });
    expect(readHonorarium({ honorariumAmount: 750, honorariumCurrency: "SAR" })).toEqual({
      amount: 750,
      currency: "SAR",
    });
  });

  it("readHonorarium is null for unset, zero, negative, NaN, and an unsupported currency", () => {
    expect(readHonorarium(null)).toBeNull();
    expect(readHonorarium(undefined)).toBeNull();
    expect(readHonorarium({})).toBeNull();
    expect(readHonorarium({ honorariumAmount: null, honorariumCurrency: null })).toBeNull();
    expect(readHonorarium({ honorariumAmount: 0, honorariumCurrency: "USD" })).toBeNull();
    expect(readHonorarium({ honorariumAmount: -10, honorariumCurrency: "USD" })).toBeNull();
    expect(readHonorarium({ honorariumAmount: "abc", honorariumCurrency: "USD" })).toBeNull();
    // A figure in a currency the form cannot pay in must read as NOT SET —
    // never rendered with that currency, never rendered as USD.
    expect(readHonorarium({ honorariumAmount: 100, honorariumCurrency: "EUR" })).toBeNull();
    expect(readHonorarium({ honorariumAmount: 100, honorariumCurrency: null })).toBeNull();
  });

  it("formatHonorarium: currency + 2dp with thousands, and 0.00 when none is agreed", () => {
    expect(formatHonorarium({ amount: 1500, currency: "USD" })).toBe("USD 1,500.00");
    expect(formatHonorarium({ amount: 99.5, currency: "AED" })).toBe("AED 99.50");
    // Owner rule: unset shows as 0, never as a blank the template swallows.
    expect(formatHonorarium(null)).toBe("0.00");
  });

  it("honorariumVars is the one shape every speaker send exposes", () => {
    expect(honorariumVars({ amount: 1500, currency: "USD" })).toEqual({
      honorarium: "USD 1,500.00",
      honorariumAmount: "1500.00",
      honorariumCurrency: "USD",
    });
    expect(honorariumVars(null)).toEqual({ honorarium: "0.00", honorariumAmount: "0.00", honorariumCurrency: "" });
  });

  it("effectiveClaimLines injects the organiser's fee FIRST and drops any SPEAKER_FEE the input carried", () => {
    const expenses = [line("FLIGHT", "USD", 850), line("HOTEL", "AED", 400)];
    expect(effectiveClaimLines({ amount: 1500, currency: "USD" }, expenses)).toEqual([
      line("SPEAKER_FEE", "USD", 1500),
      ...expenses,
    ]);
    // A speaker-typed fee (pre-lock snapshot, or a crafted request) is never
    // honoured — the organiser's figure replaces it, whatever it said.
    expect(
      effectiveClaimLines({ amount: 1500, currency: "USD" }, [line("SPEAKER_FEE", "USD", 9999), ...expenses]),
    ).toEqual([line("SPEAKER_FEE", "USD", 1500), ...expenses]);
  });

  it("effectiveClaimLines with no agreed fee: expenses only, and a body fee still vanishes", () => {
    expect(effectiveClaimLines(null, [line("SPEAKER_FEE", "USD", 9999), line("FLIGHT", "USD", 850)])).toEqual([
      line("FLIGHT", "USD", 850),
    ]);
    expect(effectiveClaimLines(null, [line("SPEAKER_FEE", "USD", 9999)])).toEqual([]);
  });

  it("the receipt rule runs over the effective lines: an honorarium-only claim needs just the passport", () => {
    const lines = effectiveClaimLines({ amount: 1500, currency: "USD" }, []);
    expect(requiredDocumentKinds(lines)).toEqual(["PASSPORT"]);
  });

  it("honorariumInputSchema: 0 is a valid clear, negatives and foreign currencies are not", () => {
    expect(honorariumInputSchema.safeParse({ amount: 0, currency: "USD" }).success).toBe(true);
    expect(honorariumInputSchema.safeParse({ amount: 1500, currency: "SAR" }).success).toBe(true);
    expect(honorariumInputSchema.safeParse({ amount: -1, currency: "USD" }).success).toBe(false);
    expect(honorariumInputSchema.safeParse({ amount: 100, currency: "EUR" }).success).toBe(false);
    expect(honorariumInputSchema.safeParse({ amount: "100", currency: "USD" }).success).toBe(false);
  });

  it("stripHonorariumFields removes exactly the two columns and never mutates its input", () => {
    const row = { id: "s1", firstName: "Jane", honorariumAmount: "1500.00", honorariumCurrency: "USD" };
    const out = stripHonorariumFields(row);
    expect(out).toEqual({ id: "s1", firstName: "Jane" });
    expect(row.honorariumAmount).toBe("1500.00");
    expect("honorariumAmount" in out).toBe(false);
  });
});
