import { describe, expect, it } from "vitest";
import { budgetableEvents, budgetEventLabel, uncodedRunningCount } from "@/procurement/lib/budget-events";

const ev = (id: string, status: string, code: string | null = id.toUpperCase()) => ({ id, name: `Event ${id}`, code, status });

describe("budgetableEvents", () => {
  const events = [
    ev("pub", "PUBLISHED"),
    ev("live", "LIVE"),
    ev("draft", "DRAFT"),
    ev("done", "COMPLETED"),
    ev("cancelled", "CANCELLED"),
    ev("nocode", "PUBLISHED", null),
    ev("budgeted", "LIVE"),
  ];
  const budgeted = new Set(["budgeted"]);

  it("offers only coded, published or live events without a budget", () => {
    expect(budgetableEvents(events, budgeted).map((e) => e.id)).toEqual(["pub", "live"]);
  });

  it("leaves out draft, completed and cancelled events even when coded and unbudgeted", () => {
    const ids = budgetableEvents(events, new Set()).map((e) => e.id);
    expect(ids).not.toContain("draft");
    expect(ids).not.toContain("done");
    expect(ids).not.toContain("cancelled");
  });

  it("counts only running, unbudgeted events that lack a code for the hint", () => {
    const more = [...events, ev("nocode-draft", "DRAFT", null), ev("nocode-budgeted", "LIVE", null)];
    expect(uncodedRunningCount(more, new Set(["budgeted", "nocode-budgeted"]))).toBe(1);
  });

  it("labels an event by code and name", () => {
    expect(budgetEventLabel({ code: "OGSC26", name: "OGSC 2026" })).toBe("OGSC26 · OGSC 2026");
  });
});
