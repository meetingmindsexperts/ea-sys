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
  fromDraftLine,
  fromQuoteLine,
  keepPricesIn,
  linesNeedingPrice,
  linesPricedInOtherCurrency,
  switchLinesCurrency,
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
  it("pre-fills a catalogue price only in the product's own currency", () => {
    expect(fromDraftLine(usdProduct, "USD")).toMatchObject({ unitPrice: "95000", priceCurrency: "USD", priceFromCatalogue: true });
    expect(fromDraftLine(usdProduct, "AED")).toMatchObject({ unitPrice: "", priceCurrency: null, priceFromCatalogue: false });
  });
});

describe("switching the quote currency", () => {
  it("clears an untouched catalogue price instead of relabelling it", () => {
    const [line] = switchLinesCurrency([fromDraftLine(usdProduct, "USD")], "AED");
    expect(line).toMatchObject({ unitPrice: "", priceCurrency: null });
    expect(linesPricedInOtherCurrency([line!], "AED")).toHaveLength(0);
    expect(linesNeedingPrice([line!], "AED")).toHaveLength(1);
  });

  it("re-fills the catalogue price when switching back to the product's currency", () => {
    const there = switchLinesCurrency([fromDraftLine(usdProduct, "USD")], "AED");
    const [back] = switchLinesCurrency(there, "USD");
    expect(back).toMatchObject({ unitPrice: "95000", priceCurrency: "USD", priceFromCatalogue: true });
  });

  it("fills a product's own-currency price when the quote switches to that currency", () => {
    const line = fromDraftLine(aedProductOnUsdDraft, "USD");
    expect(linesNeedingPrice([line], "USD")).toHaveLength(1);

    const [switched] = switchLinesCurrency([line], "AED");
    expect(switched).toMatchObject({ unitPrice: "20000", priceCurrency: "AED", priceFromCatalogue: true });
    expect(linesNeedingPrice([switched!], "AED")).toHaveLength(0);
  });

  it("keeps a typed price but flags it as entered in the old currency", () => {
    const typed = withTypedPrice(blankLine(), "1200", "USD");
    const [line] = switchLinesCurrency([typed], "AED");
    expect(line!.unitPrice).toBe("1200");
    expect(linesPricedInOtherCurrency([line!], "AED")).toHaveLength(1);
  });

  it("treats an edited catalogue price as the user's number, not the catalogue's", () => {
    const edited = withTypedPrice(fromDraftLine(usdProduct, "USD"), "90000", "USD");
    const [line] = switchLinesCurrency([edited], "AED");
    expect(line!.unitPrice).toBe("90000");
    expect(linesPricedInOtherCurrency([line!], "AED")).toHaveLength(1);
  });

  it("flags every price on a saved quote when its currency changes", () => {
    const saved = fromQuoteLine(
      { productCode: null, name: "Booth", description: null, quantity: 2, unitPrice: 5000, amount: 10000, crmProductId: null } as never,
      "USD",
    );
    const lines = switchLinesCurrency([saved], "EUR");
    expect(linesPricedInOtherCurrency(lines, "EUR")).toHaveLength(1);
    expect(linesPricedInOtherCurrency(lines, "USD")).toHaveLength(0);
  });

  it("lets the user confirm the flagged prices stand in the new currency", () => {
    const lines = switchLinesCurrency([withTypedPrice(blankLine(), "1200", "USD")], "AED");
    const kept = keepPricesIn(lines, "AED");
    expect(linesPricedInOtherCurrency(kept, "AED")).toHaveLength(0);
    expect(kept[0]!.unitPrice).toBe("1200");
  });

  it("re-typing a flagged price clears the flag", () => {
    const [line] = switchLinesCurrency([withTypedPrice(blankLine(), "1200", "USD")], "AED");
    const retyped = withTypedPrice(line!, "4400", "AED");
    expect(linesPricedInOtherCurrency([retyped], "AED")).toHaveLength(0);
  });

  it("leaves a line with no catalogue product and no price alone", () => {
    const [line] = switchLinesCurrency([blankLine()], "AED");
    expect(line).toMatchObject({ unitPrice: "", priceCurrency: null });
    expect(linesNeedingPrice([line!], "AED")).toHaveLength(0);
  });
});
