/**
 * CRM quote → QuickBooks readiness (Nov 4, 2026).
 *
 * Pins the owner decisions: won deals only; an existing customer, linked in
 * THIS QuickBooks company; the quote's currency must be the customer's; every
 * line from a catalogue product linked to a QuickBooks product/service (a
 * typed line refuses); the VAT code's rate must equal the quote's. And that
 * every problem is listed at once.
 */
import { describe, expect, it } from "vitest";
import {
  estimateRequestId,
  quickBooksReadiness,
  readCrmQuickBooksSettings,
  type ReadinessInput,
} from "@/crm/lib/quickbooks-rules";

const REALM = "realm-prod";

const settings = {
  realmId: REALM,
  vatTaxCodeId: "tc-5",
  vatTaxCodeName: "SR Standard 5%",
  vatRate: 5,
  noVatTaxCodeId: "tc-0",
  noVatTaxCodeName: "Out of scope",
};

function ready(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    realmId: REALM,
    dealStatus: "WON",
    company: { name: "Novartis", qboCustomerId: "c-1", qboCustomerCurrency: "USD", qboRealmId: REALM },
    quote: { currency: "USD", taxRate: 5 },
    lines: [
      { name: "Sponsorship - Gold", crmProductId: "p-1", product: { name: "Sponsorship - Gold", qboItemId: "i-1", qboRealmId: REALM } },
      { name: "Booth", crmProductId: "p-2", product: { name: "Booth", qboItemId: "i-2", qboRealmId: REALM } },
    ],
    settings,
    ...overrides,
  };
}

describe("quickBooksReadiness", () => {
  it("maps a ready quote to its customer, VAT code and one product per line", () => {
    expect(quickBooksReadiness(ready())).toEqual({ ok: true, plan: { customerId: "c-1", taxCodeId: "tc-5", itemIds: ["i-1", "i-2"] } });
  });

  it("uses the no-VAT code for a quote without VAT", () => {
    const res = quickBooksReadiness(ready({ quote: { currency: "USD", taxRate: null } }));
    expect(res).toMatchObject({ ok: true, plan: { taxCodeId: "tc-0" } });
  });

  it("refuses a deal that is not won", () => {
    const res = quickBooksReadiness(ready({ dealStatus: "OPEN" }));
    expect(res).toMatchObject({ ok: false, problems: [{ code: "DEAL_NOT_WON" }] });
  });

  it("refuses a hand-typed line and names it", () => {
    const res = quickBooksReadiness(ready({ lines: [{ name: "Extra lunch", crmProductId: null, product: null }] }));
    expect(res).toMatchObject({ ok: false, problems: [{ code: "LINE_NOT_FROM_CATALOGUE", line: 1 }] });
  });

  it("treats links made in another QuickBooks company (the sandbox) as missing", () => {
    const res = quickBooksReadiness(
      ready({
        company: { name: "Novartis", qboCustomerId: "c-1", qboCustomerCurrency: "USD", qboRealmId: "realm-sandbox" },
        lines: [{ name: "Gold", crmProductId: "p-1", product: { name: "Gold", qboItemId: "i-1", qboRealmId: "realm-sandbox" } }],
        settings: { ...settings, realmId: "realm-sandbox" },
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.problems.map((p) => p.code).sort()).toEqual(["CUSTOMER_NOT_LINKED", "PRODUCT_NOT_LINKED", "TAX_CODES_NOT_SET"]);
  });

  it("refuses a quote whose currency is not the customer's", () => {
    const res = quickBooksReadiness(ready({ quote: { currency: "AED", taxRate: 5 } }));
    expect(res).toMatchObject({ ok: false, problems: [{ code: "CURRENCY_MISMATCH" }] });
  });

  it("refuses a VAT rate the chosen QuickBooks code does not carry", () => {
    const res = quickBooksReadiness(ready({ quote: { currency: "USD", taxRate: 15 } }));
    expect(res).toMatchObject({ ok: false, problems: [{ code: "TAX_RATE_MISMATCH" }] });
  });

  it("lists every problem at once", () => {
    const res = quickBooksReadiness(
      ready({
        dealStatus: "OPEN",
        company: null,
        settings: null,
        lines: [
          { name: "Typed", crmProductId: null, product: null },
          { name: "Gold", crmProductId: "p-1", product: { name: "Gold", qboItemId: null, qboRealmId: null } },
        ],
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.problems.map((p) => p.code)).toEqual([
      "DEAL_NOT_WON",
      "CUSTOMER_NOT_LINKED",
      "TAX_CODES_NOT_SET",
      "LINE_NOT_FROM_CATALOGUE",
      "PRODUCT_NOT_LINKED",
    ]);
  });
});

describe("readCrmQuickBooksSettings", () => {
  it("reads a complete block and refuses a partial or corrupt one", () => {
    expect(readCrmQuickBooksSettings({ crmQuickBooks: settings })).toEqual(settings);
    expect(readCrmQuickBooksSettings({ crmQuickBooks: { ...settings, vatRate: "5" } })).toBeNull();
    expect(readCrmQuickBooksSettings({ crmQuickBooks: { realmId: REALM } })).toBeNull();
    expect(readCrmQuickBooksSettings(null)).toBeNull();
  });
});

describe("estimateRequestId", () => {
  it("is stable for an attempt, changes after a refusal, and fits QuickBooks' 50 characters", () => {
    expect(estimateRequestId("cmvz387go003cql18reqghduy", 0)).toBe(estimateRequestId("cmvz387go003cql18reqghduy", 0));
    expect(estimateRequestId("cmvz387go003cql18reqghduy", 1)).not.toBe(estimateRequestId("cmvz387go003cql18reqghduy", 0));
    expect(estimateRequestId("x".repeat(80), 3).length).toBeLessThanOrEqual(50);
  });
});
