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
import { describe, it, expect, vi } from "vitest";
import { redactFinancialFields } from "@/lib/finance-visibility";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// crm-route's auth import chain reaches next-auth, which doesn't load under
// vitest — the gate itself is not under test here, only the redaction.
vi.mock("@/lib/api-auth", () => ({ getOrgContext: vi.fn() }));
import { redactForCaller } from "@/crm/lib/crm-route";

/** A money-blind MEMBER context; redactForCaller only reads role + fromApiKey. */
const MEMBER_CTX = { organizationId: "org-1", userId: "u-m", role: "MEMBER", fromApiKey: false } as never;
const STAFF_CTX = { organizationId: "org-1", userId: "u-s", role: "ORGANIZER", fromApiKey: false } as never;

describe("prose-key stripping for MEMBER (R2-M12)", () => {
  it("strips task `description` and deal `lostReason` — free text that quotes the money the dealValue redaction hides", () => {
    const payload = {
      tasks: [{ id: "t-1", title: "Chase Abbott", description: "they countered at AED 480k" }],
      deal: { id: "d-1", name: "Abbott — Gold", lostReason: "they wanted 300k, we held at 500k", status: "LOST" },
    };
    const out = redactForCaller(payload, MEMBER_CTX) as typeof payload;
    expect(out.tasks[0]).not.toHaveProperty("description");
    expect(out.deal).not.toHaveProperty("lostReason");
    expect(out.tasks[0]!.title).toBe("Chase Abbott"); // titles stay
  });

  it("also covers History diff payloads — the diff keys ARE the field names", () => {
    const activity = [{ action: "UPDATE", changes: { changes: { description: { from: "480k", to: "500k" } } } }];
    const out = redactForCaller(activity, MEMBER_CTX) as typeof activity;
    expect(out[0]!.changes.changes).not.toHaveProperty("description");
  });

  it("staff (and value-seers) get the prose untouched", () => {
    const payload = { description: "AED 480k", lostReason: "300k" };
    expect(redactForCaller(payload, STAFF_CTX)).toEqual(payload);
  });
});

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

  it("strips the companies-table dealTotals rollup — an aggregate of dealValue must vanish with it", () => {
    const companyRow = {
      id: "c1",
      name: "Abbott",
      dealTotals: [{ currency: "USD", total: 50_000 }],
      primaryContact: { id: "cc-1", firstName: "Sara", lastName: "Khan" },
    };

    const redacted = redactFinancialFields(companyRow);

    expect(redacted).not.toHaveProperty("dealTotals");
    // The primary contact is not money — a MEMBER still sees who to talk to.
    expect(redacted).toMatchObject({ id: "c1", name: "Abbott", primaryContact: { firstName: "Sara" } });
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
