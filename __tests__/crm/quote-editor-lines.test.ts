/**
 * Quote editor lines: a price never silently changes currency.
 *
 * The bug this pins (review H2, Sep 15 2026): a USD catalogue price pre-filled on
 * a line stayed on it when the rep switched the quote to AED, so the PDF said
 * 95,000.00 AED for a product priced 95,000 USD, and nothing on screen said so.
 */
import { describe, expect, it } from "vitest";
import {
  blankLine,
  fromCatalogueProduct,
  fromDraftLine,
  fromQuoteLine,
  keepPricesIn,
  linesNeedingPrice,
  linesPricedInOtherCurrency,
  withTypedPrice,
} from "@/crm/lib/quote-editor-lines";

const usdProduct = {
  productCode: "SPO10001",
  name: "Sponsorship - Diamond",
  description: null,
  quantity: 1,
  unitPrice: 95000,
  productCurrency: "USD",
  cataloguePrice: 95000,
  crmProductId: "p-1",
};

const aedProductOnUsdDraft = {
  productCode: "EXH-1",
  name: "Exhibition booth",
  description: null,
  quantity: 1,
  unitPrice: null,
  productCurrency: "AED",
  cataloguePrice: 20000,
  crmProductId: "p-2",
};

describe("fromDraftLine", () => {
  it("fills the catalogue price in the product's own currency", () => {
    expect(fromDraftLine(usdProduct)).toMatchObject({ unitPrice: "95000", priceCurrency: "USD" });
    expect(fromDraftLine(aedProductOnUsdDraft)).toMatchObject({ unitPrice: "20000", priceCurrency: "AED" });
  });

  it("flags a price in another currency, and the save check refuses it (Nov 3, 2026)", () => {
    const line = fromDraftLine(aedProductOnUsdDraft);
    expect(linesPricedInOtherCurrency([line], "USD")).toHaveLength(1);
    expect(linesPricedInOtherCurrency([line], "AED")).toHaveLength(0);
    expect(linesNeedingPrice([line])).toHaveLength(0);
  });
});

describe("a currency the price was not entered in", () => {
  it("flags a typed price after the quote's currency changes, never relabelling it", () => {
    const typed = withTypedPrice(blankLine(), "1200", "USD");
    expect(typed.unitPrice).toBe("1200");
    expect(linesPricedInOtherCurrency([typed], "AED")).toHaveLength(1);
  });

  it("flags every price on a saved quote when its currency changes", () => {
    const saved = fromQuoteLine(
      { productCode: null, name: "Booth", description: null, quantity: 2, unitPrice: 5000, amount: 10000, crmProductId: null } as never,
      "USD",
    );
    expect(linesPricedInOtherCurrency([saved], "EUR")).toHaveLength(1);
    expect(linesPricedInOtherCurrency([saved], "USD")).toHaveLength(0);
  });

  it("lets the user confirm the flagged prices stand in the quote's currency", () => {
    const kept = keepPricesIn([fromDraftLine(aedProductOnUsdDraft)], "USD");
    expect(linesPricedInOtherCurrency(kept, "USD")).toHaveLength(0);
    expect(kept[0]!.unitPrice).toBe("20000");
  });

  it("re-typing a flagged price clears the flag", () => {
    const retyped = withTypedPrice(fromDraftLine(aedProductOnUsdDraft), "5450", "USD");
    expect(linesPricedInOtherCurrency([retyped], "USD")).toHaveLength(0);
  });

  it("leaves a hand-added blank line to the save check", () => {
    expect(linesNeedingPrice([blankLine()])).toHaveLength(0);
  });
});

describe("an unpriced deal line (review of abf62a0a)", () => {
  // A product whose catalogue price is in another currency joins a deal at 0;
  // the draft sends it with no price and no catalogue, and it must be flagged
  // rather than saved as a free line.
  const unpricedOnDeal = {
    productCode: "SPO10001", name: "Sponsorship - Diamond", description: null, quantity: 1,
    unitPrice: null, productCurrency: null, cataloguePrice: null, crmProductId: "p-9",
  };

  it("arrives blank and is flagged as needing a price", () => {
    const line = fromDraftLine(unpricedOnDeal);
    expect(line.unitPrice).toBe("");
    expect(linesNeedingPrice([line])).toHaveLength(1);
  });

  it("is no longer flagged once the rep types a price", () => {
    const line = withTypedPrice(fromDraftLine(unpricedOnDeal), "15000", "USD");
    expect(linesNeedingPrice([line])).toHaveLength(0);
  });
});


describe("fromCatalogueProduct (Nov 3, 2026)", () => {
  const gold = { id: "p-9", name: "Sponsorship - Gold", sku: "SPO10002", price: "75000.00", currency: "AED" };

  it("links the line to the product and fills its price in the product's currency", () => {
    expect(fromCatalogueProduct(gold)).toMatchObject({
      crmProductId: "p-9",
      productCode: "SPO10002",
      name: "Sponsorship - Gold",
      quantity: "1",
      unitPrice: "75000",
      priceCurrency: "AED",
    });
  });

  it("is flagged on a quote in another currency, never converted", () => {
    expect(linesPricedInOtherCurrency([fromCatalogueProduct(gold)], "USD")).toHaveLength(1);
  });

  it("treats a 0 price as unpriced, never a free line (review of d6cf46cb)", () => {
    const line = fromCatalogueProduct({ ...gold, price: "0.00" });
    expect(line).toMatchObject({ unitPrice: "", catalogue: null });
    expect(linesNeedingPrice([line])).toHaveLength(1);
  });

  it("asks for a price when the viewer's catalogue price is redacted", () => {
    const line = fromCatalogueProduct({ ...gold, price: undefined, sku: null });
    expect(line).toMatchObject({ unitPrice: "", productCode: "", catalogue: null });
    expect(linesNeedingPrice([line])).toHaveLength(1);
  });
});
