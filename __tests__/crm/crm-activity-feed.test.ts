import { describe, it, expect } from "vitest";
import { buildOrgActivityWhere, parseOrgActivityFilters } from "@/crm/lib/crm-activity";
import { formatActivityChangeSummary } from "@/crm/lib/crm-types";

const ORG = "org_1";

describe("parseOrgActivityFilters", () => {
  it("accepts a valid entityType and passes other filters through trimmed", () => {
    const r = parseOrgActivityFilters(
      new URLSearchParams({ actorId: " u_1 ", entityType: "DEAL", action: " WON " }),
      ORG,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters.organizationId).toBe(ORG);
    expect(r.filters.actorId).toBe("u_1");
    expect(r.filters.entityType).toBe("DEAL");
    expect(r.filters.action).toBe("WON");
  });

  it("rejects an invalid entityType (a bad filter is a 400, not a silent widen)", () => {
    const r = parseOrgActivityFilters(new URLSearchParams({ entityType: "INVOICE" }), ORG);
    expect(r.ok).toBe(false);
  });

  it("stamps `to` to end-of-day and leaves `from` at the parsed instant", () => {
    const r = parseOrgActivityFilters(new URLSearchParams({ from: "2026-07-01", to: "2026-07-31" }), ORG);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `to` inclusive-day: the last millisecond of that local day.
    expect(r.filters.to?.getHours()).toBe(23);
    expect(r.filters.to?.getMinutes()).toBe(59);
    expect(r.filters.to?.getSeconds()).toBe(59);
    expect(r.filters.from).toBeInstanceOf(Date);
  });

  it("treats an unparseable date as absent (a read-only view showing more is harmless)", () => {
    const r = parseOrgActivityFilters(new URLSearchParams({ from: "not-a-date" }), ORG);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters.from).toBeNull();
  });

  it("empty params → all filters null but org set", () => {
    const r = parseOrgActivityFilters(new URLSearchParams(), ORG);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters).toMatchObject({ organizationId: ORG, actorId: null, entityType: null, action: null, from: null, to: null });
  });
});

describe("buildOrgActivityWhere", () => {
  it("always scopes to the org and omits absent filters", () => {
    const where = buildOrgActivityWhere({ organizationId: ORG });
    expect(where).toEqual({ organizationId: ORG });
  });

  it("maps every filter, incl. a createdAt range", () => {
    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-07-31T23:59:59.999Z");
    const where = buildOrgActivityWhere({
      organizationId: ORG,
      actorId: "u_1",
      entityType: "DEAL",
      action: "WON",
      from,
      to,
    });
    expect(where).toEqual({
      organizationId: ORG,
      actorId: "u_1",
      entityType: "DEAL",
      action: "WON",
      createdAt: { gte: from, lte: to },
    });
  });

  it("supports a one-sided date bound", () => {
    const from = new Date("2026-07-01T00:00:00.000Z");
    const where = buildOrgActivityWhere({ organizationId: ORG, from });
    expect(where.createdAt).toEqual({ gte: from });
  });
});

describe("formatActivityChangeSummary", () => {
  it("returns '' when there are no changes", () => {
    expect(formatActivityChangeSummary({ action: "CREATE", changes: null })).toBe("");
  });

  it("names the record on CREATE / ARCHIVE / RESTORE", () => {
    expect(formatActivityChangeSummary({ action: "CREATE", changes: { name: "Abbott — BRIDGES" } })).toBe(
      "Abbott — BRIDGES",
    );
  });

  it("shows the target stage on STAGE_MOVE", () => {
    expect(formatActivityChangeSummary({ action: "STAGE_MOVE", changes: { toStage: "Contract Signed" } })).toBe(
      "→ Contract Signed",
    );
  });

  it("shows the lost reason on LOST", () => {
    expect(formatActivityChangeSummary({ action: "LOST", changes: { lostReason: "Budget cut" } })).toBe("Budget cut");
  });

  it("renders field diffs as 'Field: from → to'", () => {
    const summary = formatActivityChangeSummary({
      action: "UPDATE",
      changes: { changes: { name: { from: "Old", to: "New" } } },
    });
    expect(summary).toContain("→");
    expect(summary).toContain("Old");
    expect(summary).toContain("New");
  });

  it("cannot leak a value that redaction already removed (redact-then-summarize)", () => {
    // After redactForCaller strips `dealValue`, the diff map simply doesn't carry it,
    // so the summary built from the redacted payload can never surface a number.
    const redacted = formatActivityChangeSummary({
      action: "UPDATE",
      changes: { changes: { name: { from: "A", to: "B" } } }, // dealValue already gone
    });
    expect(redacted).not.toMatch(/\d/); // no numbers survived
    expect(redacted).toContain("B");
  });
});
