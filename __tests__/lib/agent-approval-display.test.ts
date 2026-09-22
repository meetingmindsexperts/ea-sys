/**
 * The approval card's rows: the person must be able to read exactly what is
 * about to run. Found Sep 22, 2026: a replace_budget_lines call showed its
 * lines as "2 items", so nothing on the card said what the figures were.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { approvalRows, humanizeKey, shortValue } from "@/lib/agent/approval-display";
import { ApprovalCard } from "@/components/agent/approval-card";

describe("approvalRows", () => {
  it("opens an array of objects into one readable row per item, with the item's own fields", () => {
    const rows = approvalRows({
      budgetId: "b1",
      lines: [
        { categoryCode: "510400", description: "Hall Hire", unitCost: 25000 },
        { categoryCode: "500500", description: "Gala Dinner", unitCost: 12000, qty: 2, notes: "" },
      ],
    });
    expect(rows.map((r) => r.label)).toEqual(["budget id", "lines"]);
    expect(rows[1].text).toBe("2 items");
    expect(rows[1].items).toEqual([
      "1. category code 510400, description Hall Hire, unit cost 25000",
      "2. category code 500500, description Gala Dinner, unit cost 12000, qty 2",
    ]);
  });

  it("writes an array of plain values out, leaves empty values off, and never prints JSON braces", () => {
    const rows = approvalRows({ recipientType: "speakers", speakerIds: ["s1", "s2"], subject: "", note: null, count: 3 });
    expect(rows).toEqual([
      { label: "recipient type", text: "speakers" },
      { label: "speaker ids", text: "s1, s2" },
      { label: "count", text: "3" },
    ]);
    expect(shortValue({ a: 1, b: "x" })).toBe("a 1, b x");
  });

  it("caps a long list at twenty items and says how many more there are", () => {
    const lines = Array.from({ length: 23 }, (_, i) => ({ description: `Line ${i + 1}`, unitCost: i }));
    const [row] = approvalRows({ lines });
    expect(row.items).toHaveLength(21);
    expect(row.items![20]).toBe("and 3 more");
  });

  it("humanizes keys and clips a long string", () => {
    expect(humanizeKey("fxRateToReporting")).toBe("fx rate to reporting");
    expect(humanizeKey("html_message")).toBe("html message");
    // 157 characters plus the ellipsis, the card's original cut.
    const clipped = shortValue("x".repeat(200));
    expect(clipped).toHaveLength(158);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

describe("ApprovalCard", () => {
  it("renders the lines a replace would write, so the person approves something they can read", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, {
        approval: {
          toolName: "replace_budget_lines",
          label: "Replace a budget's lines",
          input: { budgetId: "b1", lines: [{ categoryCode: "510400", description: "Hall Hire", unitCost: 25000 }] },
          token: "t",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          status: "pending",
        },
        disabled: false,
        onApprove: () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toContain("Replace a budget&#x27;s lines");
    expect(html).toContain("1. category code 510400, description Hall Hire, unit cost 25000");
    expect(html).not.toContain("1 item");
    expect(html).toContain("Nothing runs until you approve.");
  });
});
