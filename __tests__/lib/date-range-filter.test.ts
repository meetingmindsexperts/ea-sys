/**
 * parseDateRangeFilters — the shared created/updated date filters behind the
 * REST speakers + registrations GETs and MCP list_speakers/list_registrations
 * (incremental-sync checkpoints for integrations like the n8n→Webflow sync).
 * Pins: inclusive gte/lte mapping, error-not-silent-drop on bad values, and
 * the absent/empty = inactive contract.
 */
import { describe, it, expect } from "vitest";
import { parseDateRangeFilters, DATE_RANGE_PARAMS } from "@/lib/date-range-filter";

const from = (vals: Record<string, string | null | undefined>) =>
  parseDateRangeFilters((k) => vals[k]);

describe("parseDateRangeFilters", () => {
  it("maps the four params onto inclusive gte/lte bounds", () => {
    const r = from({
      createdAfter: "2026-07-01T00:00:00Z",
      createdBefore: "2026-07-31T23:59:59Z",
      updatedAfter: "2026-07-20T12:00:00Z",
      updatedBefore: "2026-07-21T12:00:00Z",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.active).toBe(true);
    expect(r.where).toEqual({
      createdAt: {
        gte: new Date("2026-07-01T00:00:00Z"),
        lte: new Date("2026-07-31T23:59:59Z"),
      },
      updatedAt: {
        gte: new Date("2026-07-20T12:00:00Z"),
        lte: new Date("2026-07-21T12:00:00Z"),
      },
    });
  });

  it("a single param produces a single-bound where (the sync-checkpoint shape)", () => {
    const r = from({ updatedAfter: "2026-07-21T05:00:00Z" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.where).toEqual({ updatedAt: { gte: new Date("2026-07-21T05:00:00Z") } });
    expect(r.where.createdAt).toBeUndefined();
  });

  it("no params → ok, inactive, empty where (spreads to a no-op)", () => {
    const r = from({});
    expect(r).toEqual({ ok: true, where: {}, active: false });
  });

  it("empty / whitespace values are inactive, not errors", () => {
    const r = from({ createdAfter: "", updatedAfter: "   " });
    expect(r).toEqual({ ok: true, where: {}, active: false });
  });

  it.each(DATE_RANGE_PARAMS)("an unparsable %s is an ERROR, never a silently-dropped filter", (param) => {
    const r = from({ [param]: "not-a-date" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.param).toBe(param);
    expect(r.value).toBe("not-a-date");
    expect(r.message).toContain(param);
    expect(r.message).toContain("ISO 8601");
  });

  it("a bad value among good ones still errors (all-or-nothing)", () => {
    const r = from({ createdAfter: "2026-07-01T00:00:00Z", updatedAfter: "yesterday-ish" });
    expect(r.ok).toBe(false);
  });

  it("accepts date-only ISO values (whole-day bounds)", () => {
    const r = from({ createdAfter: "2026-07-21" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.where.createdAt?.gte).toEqual(new Date("2026-07-21"));
  });
});
