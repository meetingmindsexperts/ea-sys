/**
 * How a corporate project's days and money read on a screen (review of
 * e92d660f: no test). A project's days are calendar days, so the reader's
 * timezone must never move one.
 */
import { describe, it, expect, afterEach } from "vitest";
import { projectDays, projectMoney } from "@/crm/lib/project-format";

const TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = TZ;
});

describe("projectDays", () => {
  it("names one day, a range, or nothing", () => {
    expect(projectDays(null, null)).toBeNull();
    expect(projectDays("2027-03-01", null)).toContain("2027");
    expect(projectDays("2027-03-01", "2027-03-01")).toBe(projectDays("2027-03-01", null));
    expect(projectDays("2027-03-01", "2027-03-02")).toContain(" – ");
    // An end day alone is still shown.
    expect(projectDays(null, "2027-03-02")).toBe(projectDays("2027-03-02", null));
  });

  it.each(["America/Los_Angeles", "Asia/Dubai", "Pacific/Auckland"])("reads the same day in %s", (zone) => {
    process.env.TZ = zone;
    const text = projectDays("2027-03-01", "2027-03-02") ?? "";
    const [start, end] = text.split(" – ");
    expect(start).toMatch(/\b1\b/);
    expect(start).not.toMatch(/\b28\b/);
    expect(end).toMatch(/\b2\b/);
  });
});

describe("projectMoney", () => {
  const totals = [
    { currency: "USD", open: 15000, won: 0, lost: 0, total: 15000 },
    { currency: "AED", open: 0, won: 40000, lost: 0, total: 40000 },
  ];

  it("gives one figure per currency, never a sum across them", () => {
    const open = projectMoney(totals, "open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatch(/15[,.]?000/);
    const won = projectMoney(totals, "won");
    expect(won).toHaveLength(1);
    expect(won[0]).toMatch(/40[,.]?000/);
  });

  it("is empty for a caller whose totals were removed, and for a project with no valued deal", () => {
    expect(projectMoney(undefined, "open")).toEqual([]);
    expect(projectMoney([{ currency: "USD", open: 0, won: 0, lost: 0, total: 0 }], "open")).toEqual([]);
  });
});
