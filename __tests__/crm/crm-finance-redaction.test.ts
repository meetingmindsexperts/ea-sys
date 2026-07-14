/**
 * Regression harness for the near-miss found while wiring the CRM into the
 * finance boundary (July 14, 2026).
 *
 * `redactFinancialFields()` is a RECURSIVE strip-by-key-NAME: it removes any key
 * in FINANCIAL_KEYS anywhere in the payload, at any depth. The CRM plan said to
 * add `CrmDeal.value` to that set — but `value` is a generic key that already
 * occurs in unrelated shapes, most notably survey free-text answers
 * (`{ responseId, submittedAt, value }`, src/lib/survey/aggregate.ts).
 *
 * Adding bare `"value"` would therefore have silently blanked EVERY survey
 * answer for MEMBER — a brand-new feature breaking a long-shipped one, with no
 * error and no log. The column is named `dealValue` precisely so its redaction
 * key is unambiguous.
 *
 * These tests pin BOTH halves of that decision. If someone renames the column
 * back to `value` (or adds a generic key to FINANCIAL_KEYS), the second test
 * fails and explains why.
 */
import { describe, it, expect } from "vitest";
import { redactFinancialFields } from "@/lib/finance-visibility";

describe("CRM deal value redaction", () => {
  it("strips dealValue from a deal payload", () => {
    const deal = {
      id: "d1",
      name: "Abbott — BRIDGES 2026 Gold",
      stageId: "s1",
      dealValue: 40000,
      currency: "USD",
      company: { id: "c1", name: "Abbott" },
    };

    const redacted = redactFinancialFields(deal);

    expect(redacted).not.toHaveProperty("dealValue");
    // Everything a MEMBER legitimately needs to read the board survives.
    expect(redacted).toMatchObject({
      id: "d1",
      name: "Abbott — BRIDGES 2026 Gold",
      stageId: "s1",
      currency: "USD",
      company: { name: "Abbott" },
    });
  });

  it("strips dealValue at depth (board grouped by stage)", () => {
    const board = {
      stages: [
        { id: "s1", name: "Negotiation", deals: [{ id: "d1", dealValue: 40000, name: "Abbott" }] },
      ],
    };

    const redacted = redactFinancialFields(board);

    expect(redacted.stages[0].deals[0]).not.toHaveProperty("dealValue");
    expect(redacted.stages[0].deals[0]).toMatchObject({ id: "d1", name: "Abbott" });
  });

  it("does NOT strip the generic `value` key — survey answers must survive", () => {
    // THE NEAR-MISS. If `value` ever lands in FINANCIAL_KEYS, this fails and a
    // MEMBER silently stops seeing every free-text survey response in the app.
    const surveyAggregate = {
      questionId: "q1",
      responses: [
        { responseId: "r1", submittedAt: new Date("2026-01-01"), value: "Great conference" },
        { responseId: "r2", submittedAt: new Date("2026-01-02"), value: "Coffee was cold" },
      ],
    };

    const redacted = redactFinancialFields(surveyAggregate);

    expect(redacted.responses[0].value).toBe("Great conference");
    expect(redacted.responses[1].value).toBe("Coffee was cold");
  });
});
