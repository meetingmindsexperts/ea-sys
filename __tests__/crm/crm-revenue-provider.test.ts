/**
 * The CRM's side of the revenue contract: WON, live deals of one event and
 * organisation, as plain values, the live catalogue product deciding the
 * account; independent of the CRM entitlement.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { crmDeal: { findMany } } }));

import { crmRevenueProvider } from "@/crm/integrations/revenue-provider";

beforeEach(() => vi.clearAllMocks());

describe("crmRevenueProvider.wonDealsForEvent", () => {
  it("reads WON live deals of the event and organisation, as plain values", async () => {
    findMany.mockResolvedValue([
      {
        dealValue: new Prisma.Decimal("20000"),
        currency: "USD",
        products: [
          { productName: "Gold", category: "Old snapshot", unitPrice: new Prisma.Decimal("15000"), quantity: 1, currency: "USD", crmProduct: { source: "IN_HOUSE", category: "Sponsorship" } },
          { productName: "Gone", category: "Booth", unitPrice: new Prisma.Decimal("500"), quantity: 2, currency: "USD", crmProduct: null },
        ],
      },
    ]);
    const deals = await crmRevenueProvider.wonDealsForEvent({ organizationId: "org-1", eventId: "e1" });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-1", OR: [{ eventId: "e1" }, { eventId: null, project: { eventId: "e1" } }], status: "WON", archivedAt: null } }));
    expect(deals).toEqual([
      {
        dealValue: "20000",
        currency: "USD",
        products: [
          { productName: "Gold", category: "Sponsorship", source: "IN_HOUSE", quantity: 1, unitPrice: "15000", currency: "USD" },
          { productName: "Gone", category: "Booth", source: null, quantity: 2, unitPrice: "500", currency: "USD" },
        ],
      },
    ]);
  });

  it("does not consult the CRM entitlement: a suspended CRM's won deals are still revenue (owner, Nov 6)", async () => {
    findMany.mockResolvedValue([]);
    await crmRevenueProvider.wonDealsForEvent({ organizationId: "org-2", eventId: "e1" });
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
