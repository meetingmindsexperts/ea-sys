/**
 * Deal filter parsing — the finance gate and the date logic.
 *
 * The load-bearing assertion is that a MEMBER (who cannot SEE deal values) also
 * cannot FILTER by them. If they could, a redacted number becomes searchable:
 * "over $100k? … over $150k? … over $175k?" binary-searches the exact figure the
 * redaction was meant to hide. `buildDealWhere` drops value params unless
 * `canSeeValues`. The UI hides the control too, but this is the authority.
 */
import { describe, it, expect } from "vitest";
import { CrmDealPipeline } from "@prisma/client";
import { buildDealWhere, buildTaskDueRange } from "@/crm/lib/deal-filters";
import { CRM_DEAL_PIPELINES, CRM_DEAL_PIPELINE_LABELS } from "@/crm/lib/crm-types";

const ORG = "org-1";

describe("buildDealWhere — value filter is finance-gated", () => {
  it("APPLIES the value range for a caller who may see values", () => {
    const where = buildDealWhere(
      { min: "50000", max: "200000" },
      { organizationId: ORG, canSeeValues: true },
    );
    expect(where.dealValue).toEqual({ gte: 50000, lte: 200000 });
  });

  it("DROPS the value range for a caller who may NOT see values (the binary-search leak)", () => {
    const where = buildDealWhere(
      { min: "50000", max: "200000" },
      { organizationId: ORG, canSeeValues: false },
    );
    // The whole point: a MEMBER's ?min=/?max= must do nothing.
    expect(where.dealValue).toBeUndefined();
  });

  it("ignores a non-numeric value bound rather than widening", () => {
    const where = buildDealWhere({ min: "not-a-number" }, { organizationId: ORG, canSeeValues: true });
    expect(where.dealValue).toBeUndefined();
  });

  it("accepts a min without a max and vice versa", () => {
    expect(buildDealWhere({ min: "1000" }, { organizationId: ORG, canSeeValues: true }).dealValue).toEqual({ gte: 1000 });
    expect(buildDealWhere({ max: "9000" }, { organizationId: ORG, canSeeValues: true }).dealValue).toEqual({ lte: 9000 });
  });
});

describe("buildDealWhere — date range", () => {
  it("defaults the field to expectedClose", () => {
    const where = buildDealWhere({ from: "2026-07-01" }, { organizationId: ORG, canSeeValues: true });
    expect(where.expectedClose).toBeDefined();
    expect(where.createdAt).toBeUndefined();
  });

  it("honours createdAt when chosen", () => {
    const where = buildDealWhere(
      { dateField: "createdAt", from: "2026-07-01", to: "2026-07-31" },
      { organizationId: ORG, canSeeValues: true },
    );
    expect(where.createdAt).toBeDefined();
    expect(where.expectedClose).toBeUndefined();
  });

  it("spans wonAt OR lostAt for the 'closed' field", () => {
    const where = buildDealWhere(
      { dateField: "closed", from: "2026-07-01", to: "2026-07-31" },
      { organizationId: ORG, canSeeValues: true },
    );
    // A won deal stamps wonAt, a lost deal stamps lostAt — "closed in July" is either.
    expect(where.OR).toHaveLength(2);
    expect(where.OR).toEqual([
      { wonAt: expect.any(Object) },
      { lostAt: expect.any(Object) },
    ]);
  });

  it("makes the `to` bound inclusive of the whole day", () => {
    const where = buildDealWhere(
      { dateField: "createdAt", to: "2026-07-31" },
      { organizationId: ORG, canSeeValues: true },
    );
    const range = where.createdAt as { lte: Date };
    // UTC, deliberately (M11): parseDate yields UTC midnight, so the inclusive
    // end-of-day bound must be UTC too — server-local hours would drift per host.
    expect(range.lte.getUTCHours()).toBe(23);
    expect(range.lte.getUTCMinutes()).toBe(59);
  });

  it("ignores an unparseable date rather than narrowing to nothing", () => {
    const where = buildDealWhere({ from: "garbage" }, { organizationId: ORG, canSeeValues: true });
    expect(where.expectedClose).toBeUndefined();
  });

  it("rejects an unknown dateField by falling back to expectedClose", () => {
    const where = buildDealWhere(
      { dateField: "createdAt; DROP TABLE", from: "2026-07-01" },
      { organizationId: ORG, canSeeValues: true },
    );
    expect(where.expectedClose).toBeDefined();
  });
});

describe("buildDealWhere — scalar filters + tenancy", () => {
  it("always binds organizationId", () => {
    expect(buildDealWhere({}, { organizationId: ORG, canSeeValues: true }).organizationId).toBe(ORG);
  });

  it("applies owner, event, and a valid status; ignores a bad status", () => {
    const where = buildDealWhere(
      { ownerId: "u-1", eventId: "e-1", status: "WON" },
      { organizationId: ORG, canSeeValues: true },
    );
    expect(where.ownerId).toBe("u-1");
    expect(where.eventId).toBe("e-1");
    expect(where.status).toBe("WON");

    const bad = buildDealWhere({ status: "MADE_UP" }, { organizationId: ORG, canSeeValues: true });
    expect(bad.status).toBeUndefined();
  });

  it("applies a valid pipeline; ignores an unknown one rather than widening", () => {
    expect(
      buildDealWhere({ pipeline: "CORPORATE" }, { organizationId: ORG, canSeeValues: true }).pipeline,
    ).toBe("CORPORATE");
    expect(
      buildDealWhere({ pipeline: "CONFERENCE" }, { organizationId: ORG, canSeeValues: true }).pipeline,
    ).toBe("CONFERENCE");
    // A bad value must not apply a predicate (and must not throw).
    expect(
      buildDealWhere({ pipeline: "MADE_UP" }, { organizationId: ORG, canSeeValues: true }).pipeline,
    ).toBeUndefined();
    // The pipeline filter is NOT finance-gated — it applies for a money-blind caller.
    expect(
      buildDealWhere({ pipeline: "CORPORATE" }, { organizationId: ORG, canSeeValues: false }).pipeline,
    ).toBe("CORPORATE");
  });

  it("applies a dealTypeId filter (an unknown id simply narrows to nothing)", () => {
    expect(
      buildDealWhere({ dealTypeId: "dt-1" }, { organizationId: ORG, canSeeValues: true }).dealTypeId,
    ).toBe("dt-1");
    // Absent → no predicate.
    expect(buildDealWhere({}, { organizationId: ORG, canSeeValues: true }).dealTypeId).toBeUndefined();
  });
});

describe("CrmDealPipeline ↔ CRM_DEAL_PIPELINES drift guard", () => {
  // The client-safe UI constant (crm-types) and the Prisma enum (service/Zod) are
  // two separate declarations. If the Prisma enum gains a value that the UI
  // constant + labels don't, a saved deal renders a BLANK pipeline badge and is
  // missing from the filter dropdown — silently. Pin them equal BOTH ways so a
  // future `ALTER TYPE … ADD VALUE` fails CI instead of the page (review LOW-1).
  it("the UI pipeline list matches the Prisma enum exactly", () => {
    expect([...CRM_DEAL_PIPELINES].sort()).toEqual([...Object.values(CrmDealPipeline)].sort());
  });

  it("every pipeline value has a display label", () => {
    for (const p of Object.values(CrmDealPipeline)) {
      expect(CRM_DEAL_PIPELINE_LABELS[p]).toBeTruthy();
    }
  });
});

describe("buildTaskDueRange", () => {
  it("returns null when neither bound is set", () => {
    expect(buildTaskDueRange({})).toBeNull();
  });

  it("builds an inclusive-to range", () => {
    const range = buildTaskDueRange({ from: "2026-07-01", to: "2026-07-07" });
    expect(range?.gte).toBeInstanceOf(Date);
    expect((range?.lte as Date).getUTCHours()).toBe(23);
  });
});
