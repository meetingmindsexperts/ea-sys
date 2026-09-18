/**
 * The report breakdown reads the SAME `where` as the report's aggregates and
 * costs nothing when nobody asked for it.
 *
 * The bucketing math is pinned next door (reports.test.ts). What THIS pins is
 * the service wiring: (1) no groupBy → no deal read at all, breakdown null;
 * (2) the breakdown's deal read uses the exact predicate the stage/win-loss
 * aggregates use, so a bucket total can never disagree with the pipeline
 * total beside it; (3) name lookups are org-bound and fetched only for the
 * dimension in use; (4) a money-blind caller gets redacted buckets.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmPipelineStage: { findMany: vi.fn() },
    crmDeal: { groupBy: vi.fn(), findMany: vi.fn() },
    crmDealType: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { buildCrmReport } from "@/crm/services/report-service";

const ORG = "org-1";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue([
    { id: "s1", name: "New", isTerminal: false },
    { id: "s2", name: "Won", isTerminal: true },
  ] as never);
  vi.mocked(db.crmDeal.groupBy).mockResolvedValue([] as never);
  vi.mocked(db.user.findMany).mockResolvedValue([{ id: "u1", firstName: "Ada", lastName: "Lovelace" }] as never);
  vi.mocked(db.event.findMany).mockResolvedValue([{ id: "e1", name: "HEMNET 2026" }] as never);
  vi.mocked(db.crmDealType.findMany).mockResolvedValue([{ id: "t1", name: "Sponsorship" }] as never);
  vi.mocked(db.crmDeal.findMany).mockResolvedValue([
    { status: "OPEN", currency: "USD", dealValue: 100, pipeline: "CORPORATE", ownerId: "u1", eventId: "e1", dealTypeId: "t1", lostReason: null, expectedClose: null, wonAt: null, lostAt: null },
    { status: "WON", currency: "USD", dealValue: 50, pipeline: "CORPORATE", ownerId: "u1", eventId: "e1", dealTypeId: null, lostReason: null, expectedClose: null, wonAt: new Date("2026-08-01T00:00:00Z"), lostAt: null },
  ] as never);
});

describe("buildCrmReport — breakdown wiring", () => {
  it("reads no deal rows and returns breakdown: null when no dimension is asked for", async () => {
    const report = await buildCrmReport({ organizationId: ORG, canSeeValues: true, filters: {} });
    expect(report.breakdown).toBeNull();
    expect(db.crmDeal.findMany).not.toHaveBeenCalled();
    expect(db.event.findMany).not.toHaveBeenCalled();
    expect(db.crmDealType.findMany).not.toHaveBeenCalled();
  });

  it("reads the breakdown rows with the SAME where the aggregates use", async () => {
    await buildCrmReport({
      organizationId: ORG,
      canSeeValues: true,
      groupBy: "pipeline",
      filters: { ownerId: "u1", pipeline: "CORPORATE", dateField: "createdAt", from: "2026-01-01" },
    });
    const aggregateWhere = vi.mocked(db.crmDeal.groupBy).mock.calls[0]![0]!.where;
    const breakdownWhere = vi.mocked(db.crmDeal.findMany).mock.calls[0]![0]!.where;
    expect(breakdownWhere).toEqual(aggregateWhere);
    expect(breakdownWhere).toMatchObject({ organizationId: ORG, archivedAt: null, ownerId: "u1", pipeline: "CORPORATE" });
  });

  it("fetches only the lookup the dimension needs, bound to the organization", async () => {
    const byEvent = await buildCrmReport({ organizationId: ORG, canSeeValues: true, groupBy: "event", filters: {} });
    expect(db.event.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG } }));
    expect(db.crmDealType.findMany).not.toHaveBeenCalled();
    expect(byEvent.breakdown?.rows.map((r) => r.label)).toEqual(["HEMNET 2026"]);

    vi.clearAllMocks();
    vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue([] as never);
    vi.mocked(db.crmDeal.groupBy).mockResolvedValue([] as never);
    vi.mocked(db.user.findMany).mockResolvedValue([] as never);
    vi.mocked(db.crmDealType.findMany).mockResolvedValue([{ id: "t1", name: "Sponsorship" }] as never);
    vi.mocked(db.crmDeal.findMany).mockResolvedValue([
      { status: "OPEN", currency: "USD", dealValue: 1, pipeline: null, ownerId: null, eventId: null, dealTypeId: "t1", lostReason: null, expectedClose: null, wonAt: null, lostAt: null },
      { status: "OPEN", currency: "USD", dealValue: 1, pipeline: null, ownerId: null, eventId: null, dealTypeId: null, lostReason: null, expectedClose: null, wonAt: null, lostAt: null },
    ] as never);
    const byType = await buildCrmReport({ organizationId: ORG, canSeeValues: true, groupBy: "dealType", filters: {} });
    expect(db.event.findMany).not.toHaveBeenCalled();
    expect(db.crmDealType.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG } }));
    expect(byType.breakdown?.rows.map((r) => r.label)).toEqual(["Sponsorship", "No deal type"]);
  });

  it("names the rep from the same user list the leaderboard uses", async () => {
    const report = await buildCrmReport({ organizationId: ORG, canSeeValues: true, groupBy: "owner", filters: {} });
    expect(report.breakdown).toMatchObject({
      dimension: "owner",
      rows: [{ label: "Ada Lovelace", totalCount: 2, openCount: 1, openValue: 100, wonCount: 1, wonValue: 50, winRate: 100 }],
    });
  });

  it("redacts bucket values for a caller who may not see money", async () => {
    const report = await buildCrmReport({ organizationId: ORG, canSeeValues: false, groupBy: "pipeline", filters: {} });
    expect(report.breakdown?.rows[0]).toMatchObject({ label: "Corporate", totalCount: 2, openValue: null, wonValue: null, openCurrency: null });
  });
});
