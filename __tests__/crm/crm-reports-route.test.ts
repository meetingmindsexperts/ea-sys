/**
 * GET /api/crm/reports — the groupBy contract at the boundary.
 *
 * A dimension name that is not one must be a logged 400, never a report with a
 * silently missing breakdown (the "bad filter must not quietly change the
 * result" rule the deal filters already follow). And the new filters the
 * report honours (pipeline, deal type) must reach the service by the names the
 * filter builder reads.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/crm/lib/crm-route", () => ({
  requireCrmRead: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: "ADMIN", fromApiKey: false },
  })),
}));

vi.mock("@/crm/services/report-service", () => ({
  buildCrmReport: vi.fn(async () => ({
    pipeline: { stages: [], openCount: 0, openValue: 0, openCurrency: null, openMixed: false },
    winLoss: { wonCount: 0, lostCount: 0, wonValue: 0, lostValue: 0, winRate: null },
    reps: [],
    breakdown: null,
  })),
}));

import { apiLogger } from "@/lib/logger";
import { buildCrmReport } from "@/crm/services/report-service";
import { GET } from "@/app/api/crm/reports/route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/crm/reports — groupBy", () => {
  it("refuses a value that is not a dimension with a logged 400 and no report", async () => {
    const res = await GET(new Request("http://x/api/crm/reports?groupBy=stage"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "INVALID_GROUP_BY" });
    expect(buildCrmReport).not.toHaveBeenCalled();
    expect(apiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "crm/reports:invalid-group-by", groupBy: "stage" }));
  });

  it("passes a valid dimension and the pipeline / deal-type filters to the service", async () => {
    const res = await GET(new Request("http://x/api/crm/reports?groupBy=closedMonth&pipeline=CONFERENCE&dealTypeId=t1&eventId=e1"));
    expect(res.status).toBe(200);
    expect(buildCrmReport).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        groupBy: "closedMonth",
        filters: expect.objectContaining({ pipeline: "CONFERENCE", dealTypeId: "t1", eventId: "e1" }),
      }),
    );
  });

  it("asks for no breakdown when groupBy is absent", async () => {
    const res = await GET(new Request("http://x/api/crm/reports"));
    expect(res.status).toBe(200);
    expect(vi.mocked(buildCrmReport).mock.calls[0]![0]!.groupBy).toBeNull();
    await expect(res.json()).resolves.toMatchObject({ breakdown: null, canSeeValues: true });
  });
});
