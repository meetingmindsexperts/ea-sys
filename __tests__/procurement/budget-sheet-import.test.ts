/**
 * The budget sheet reader, on INVENTED rows with the same layout and the same
 * quirks as finance's real costing sheets (the real files are never fixtures,
 * docs/BUDGET_AI_PLAN.md 2a.4): semicolons, "AED 1,234" and "-AED" amounts, a
 * quoted comment spanning two lines, repeated header rows, group labels,
 * subtotals that leave a line out, internal lines with a zeroed cost, quotes
 * never ordered, duplicate line numbers, and the result written loose below
 * the grand total.
 */
import { describe, expect, it } from "vitest";
import {
  detectDelimiter,
  incomeAccountFor,
  parseAmount,
  parseBudgetSheet,
  planBudgetSheet,
  planTotals,
  suggestProduct,
  tokenise,
  type CatalogueProduct,
} from "@/procurement/lib/budget-sheet-import";

const H = "SUBJECT;ITEMS;TYPE;ACT COST;ITEMS;DAYS;TOTAL AED;PER UNIT;ITEMS;DAYS;TOTAL AED;MARGIN;%;VENDOR;QUOTATION;COMMENTS";

const SHEET = [
  "Test Congress 2027;;;;;;;;;;;;;;;",
  H,
  "01 - Venue & Build;;;;;;;;;;;;;;;",
  " ;VENUE - Grand Hotel;;; ; ; ;; ; ; ;;;;;",
  "1.1;Day Delegate Rate ;External;AED 101;100;2;AED 20,250;AED 120;80;2;AED 19,200;-AED 1,050;-5%;Grand Hotel;QUOTATION;",
  '1.2;Venue Branding;External;AED 1,000;1;1;AED 1,000;AED 3,000;1;1;AED 3,000;AED 2,000;67%;;Estimate;"Photowall',
  'Welcome banner";',
  "1.3;Poster Panels;External;AED 500;0;1;AED 0;AED 500;4;1;AED 2,000;AED 2,000;100%;Build Co;QUOTATION;",
  ";Total Venue;;;;;AED 21,250;;;;AED 22,200;AED 950;4%;;;",
  H,
  "02 - People;;;;;;;;;;;;;;;",
  "2.1;Project Manager;Internal;AED 10,000;0;1;AED 0;AED 10,000;1;1;AED 10,000;AED 10,000;100%;;;",
  "2.2;Registration Portal;Internal;AED 0;1;1;AED 0;AED 5,000;1;1;AED 5,000;AED 5,000;100%;;;",
  "2.3;Speaker Flights;External;AED 9,000;1;1;AED 9,000;AED 2,000;4;1;AED 8,000;-AED 1,000;-13%;;QUOTATION;",
  "2.4;Gala Dinner;External;AED 200;0;1;AED 0;;;;;;;;Estimate;",
  ";Speaker Visas;External;AED 100;2;1;AED 200;;;;;;;Police;QUOTATION;",
  "2.4;Live Feed;External;AED 1,500;1;2;AED 3,000;;;;;;;AV Co;QUOTATION;for 2 days",
  "2.5;Poster Panels;External;AED 150;4;1;AED 600;;;;;;;Print Co;Estimate;",
  ";Total - 02 - People;;;;;AED 12,800;;;;AED 23,000;AED 14,000;61%;;;",
  ";SUBTOTAL EXPENSES;;;;;AED 34,050;;;;AED 45,200;AED 14,950;33%;;;",
  "03 - Finance;;;;;;;;;;;;;;;",
  "3.1;Contingency (5%);;AED 1,703;0;1;AED 0;AED 1,702.50;1;1;AED 1,703;AED 1,703;100%;;;Buffer",
  ";Total - 03 - Finance;;;;;AED 0;;;;AED 1,703;AED 1,703;;;",
  ";TOTAL EXPENSES;;;;;AED 34,050;;;;AED 46,903;AED 16,653;;;",
  ";;;;;;AED 40,000.00 ;;;;;;;;;",
  ";;;;;;;;;;;;;AED 5,950.00 ;;",
  ";;;;2026 Expense;;AED 30,000;;;;;;;;;",
  ";;;; 2026 Income ;;AED38,000.00;;;;;;;;;",
  ";;;;;;;;;;;;;;;",
].join("\n");

const PRODUCTS: CatalogueProduct[] = [
  { id: "p-ddr", sku: "510401", name: "Day Delegate Rate", isActive: true },
  { id: "p-brand", sku: "500315", name: "Venue Branding Production", isActive: true },
  { id: "p-poster", sku: "510306", name: "Poster Area Build", isActive: true },
  { id: "p-dir", sku: "510006", name: "Conference Director", isActive: true },
  { id: "p-portal", sku: "500207", name: "Delegate Registration Portal", isActive: true },
  { id: "p-air", sku: "510203", name: "Speaker Air Ticket", isActive: true },
  { id: "p-gala", sku: "500503", name: "Conference Dinner", isActive: true },
  { id: "p-visa", sku: "510208", name: "Speaker Visa Application Charges", isActive: true },
  { id: "p-special", sku: "510317", name: "Special Features", isActive: true },
  { id: "p-old", sku: "510301", name: "Audio Video Equipment Rental", isActive: false },
];

const parsed = parseBudgetSheet(SHEET);
const plan = planBudgetSheet(parsed, { products: PRODUCTS, countInternalCost: true });
const line = (ref: string, nth = 0) => plan.lines.filter((l) => l.ref === ref)[nth];
const kinds = (kind: string) => plan.warnings.filter((w) => w.kind === kind);

describe("tokenising and amounts", () => {
  it("detects the semicolon sheet and a comma file", () => {
    expect(detectDelimiter(SHEET)).toBe(";");
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
  });
  it("keeps a quoted cell that spans two lines as one cell", () => {
    const rows = tokenise('a;"one\ntwo";c\nd;e;f', ";");
    expect(rows).toEqual([["a", "one\ntwo", "c"], ["d", "e", "f"]]);
  });
  it("reads currency-prefixed, negative, bracketed and plain amounts", () => {
    expect(parseAmount("AED 1,234")).toBe(1234);
    expect(parseAmount("-AED 15,426")).toBe(-15426);
    expect(parseAmount("AED637,345.20")).toBe(637345.2);
    expect(parseAmount("AED -12")).toBe(-12);
    expect(parseAmount("(500)")).toBe(-500);
    expect(parseAmount(" 150 ")).toBe(150);
    expect(parseAmount("  ")).toBeNull();
    expect(parseAmount("n/a")).toBeNaN();
  });
});

describe("parseBudgetSheet", () => {
  it("takes the title from above the header and reads only real lines", () => {
    expect(parsed.title).toBe("Test Congress 2027");
    expect(parsed.errors).toEqual([]);
    // Section rows, group labels, repeated headers, totals and the footer are never lines.
    expect(parsed.lines.map((l) => l.ref || l.description)).toEqual(["1.1", "1.2", "1.3", "2.1", "2.2", "2.3", "2.4", "Speaker Visas", "2.4", "2.5", "3.1"]);
  });
  it("carries section, group, type, vendor and the two-line comment", () => {
    const ddr = parsed.lines[0];
    expect(ddr).toMatchObject({ section: "01 - Venue & Build", group: "VENUE - Grand Hotel", type: "EXTERNAL", vendor: "Grand Hotel", description: "Day Delegate Rate" });
    expect(parsed.lines[1].comments).toBe("Photowall; Welcome banner");
  });
  it("leaves the billed block null when the sheet left it blank", () => {
    expect(parsed.lines.find((l) => l.description === "Speaker Visas")!.billed).toBeNull();
  });
  it("reads the contingency percent from its label", () => {
    expect(parsed.lines.at(-1)!.contingencyPercent).toBe(5);
  });
  it("collects the loose figures below the grand total, labelled where the sheet labels them", () => {
    expect(parsed.footer.map((f) => [f.label, f.value])).toEqual([["", 40000], ["", 5950], ["2026 Expense", 30000], ["2026 Income", 38000]]);
  });
  it("refuses a file with no header row", () => {
    expect(parseBudgetSheet("name,amount\nVenue,100").errors[0].message).toMatch(/No header row/);
  });
  it("skips and names a row whose amount is not a number", () => {
    const bad = parseBudgetSheet([H, "01 - A;;;;;;;;;;;;;;;", "1.1;Venue;External;lots;1;1;AED 5;;;;;;;;;"].join("\n"));
    expect(bad.lines).toEqual([]);
    expect(bad.errors[0].message).toMatch(/Row 3 \(Venue\) has an amount that is not a number/);
  });
});

describe("planBudgetSheet: figures", () => {
  it("uses the TOTAL cell and derives the unit, so qty × unit reproduces the sheet", () => {
    // 101 is the displayed unit; 20,250 / 200 is the real one.
    expect(line("1.1")).toMatchObject({ costQty: 200, costUnit: 101.25, costTotal: 20250, billedQty: 160, billedUnit: 120, billedTotal: 19200 });
  });
  it("counts an internal cost the sheet zeroed, at the billed quantity, and says so in the notes", () => {
    expect(line("2.1")).toMatchObject({ costQty: 1, costUnit: 10000, costTotal: 10000, internalCostCounted: true });
    expect(line("2.1").notes).toContain("Internal cost counted");
  });
  it("leaves that cost at zero when the option is off", () => {
    const off = planBudgetSheet(parsed, { products: PRODUCTS, countInternalCost: false });
    expect(off.lines.find((l) => l.ref === "2.1")).toMatchObject({ costTotal: 0, internalCostCounted: false });
    expect(off.totals.cost).toBe(plan.totals.cost - 10000);
  });
  it("leaves a quote with quantity 0 out by default and keeps everything else in", () => {
    expect(line("2.4")).toMatchObject({ description: "Gala Dinner", include: false });
    expect(plan.lines.filter((l) => !l.include).map((l) => l.description)).toEqual(["Gala Dinner"]);
  });
  it("takes the contingency percent and files the billed buffer under Event Finance", () => {
    expect(plan.contingencyPercent).toBe(5);
    expect(line("3.1")).toMatchObject({ isContingency: true, include: true, productId: null, billedTotal: 1703, incomeAccount: "430007" });
  });
  it("totals cost and billed from the lines, never from the sheet's subtotals", () => {
    // 20,250 + 1,000 + 0 + 10,000 (internal counted) + 0 + 9,000 + 200 + 3,000 + 600
    expect(plan.totals.cost).toBe(44050);
    // 19,200 + 3,000 + 2,000 + 10,000 + 5,000 + 8,000 + 1,703
    expect(plan.totals.billed).toBe(48903);
    expect(plan.totals.margin).toBe(4853);
  });
  it("recomputes totals after a line is unticked on the preview", () => {
    const edited = plan.lines.map((l) => (l.ref === "2.3" ? { ...l, include: false } : l));
    expect(planTotals(edited)).toMatchObject({ cost: 35050, billed: 40903 });
  });
});

describe("planBudgetSheet: products and income accounts", () => {
  it("suggests a catalogue product by rule, then by whole name, and never an archived one", () => {
    expect(line("1.1").productId).toBe("p-ddr");
    expect(line("2.1").productId).toBe("p-dir");
    expect(suggestProduct("Conference Director fees", PRODUCTS)?.id).toBe("p-dir");
    expect(suggestProduct("Staging & AV Equipment", PRODUCTS)).toBeNull();
  });
  it("picks the in-house account for internal work and the out-sourced one for a supplier's", () => {
    expect(line("2.1").incomeAccount).toBe("430011");
    expect(line("2.2").incomeAccount).toBe("430009");
    expect(line("1.1").incomeAccount).toBe("440011");
    expect(line("2.3").incomeAccount).toBe("440010");
    expect(incomeAccountFor("500901", "EXTERNAL", false)).toBe("430007");
    expect(incomeAccountFor(null, "EXTERNAL", false)).toBeNull();
  });
  it("gives a line with nothing billed no income account", () => {
    expect(plan.lines.find((l) => l.description === "Speaker Visas")!.incomeAccount).toBeNull();
  });
});

describe("planBudgetSheet: warnings", () => {
  it("names the line a subtotal left out", () => {
    const m = kinds("SUBTOTAL_MISMATCH").map((w) => w.message);
    expect(m).toContainEqual(expect.stringContaining('"Total Venue" states billed AED 22,200; its lines add up to AED 24,200. It leaves out 1.3 Poster Panels (AED 2,000).'));
  });
  it("says when the grand total's gap comes from the section totals", () => {
    expect(kinds("SUBTOTAL_MISMATCH").find((w) => w.message.startsWith('"SUBTOTAL EXPENSES"'))!.message).toMatch(/section totals above explain the gap/);
  });
  it("flags costs billed to nobody, and billing below cost", () => {
    expect(kinds("UNBILLED_COST").map((w) => w.rowNum)).toEqual([15, 16, 17]);
    expect(kinds("BILLED_BELOW_COST").map((w) => w.message)).toEqual([
      "1.1 Day Delegate Rate bills AED 19,200 against a cost of AED 20,250: a loss of AED 1,050.",
      "2.3 Speaker Flights bills AED 8,000 against a cost of AED 9,000: a loss of AED 1,000.",
    ]);
  });
  it("points a billed line with no cost at the same item costed elsewhere", () => {
    expect(kinds("BILLED_WITHOUT_COST")[0].message).toBe("1.3 Poster Panels bills AED 2,000 but records no cost (quantity 0). The cost may be on 2.5 Poster Panels (AED 600, Print Co).");
  });
  it("flags the zeroed internal cost, never also as a unit-total mismatch", () => {
    expect(kinds("INTERNAL_COST_ZERO").map((w) => w.rowNum)).toEqual([11]);
    expect(kinds("UNIT_TOTAL_MISMATCH")).toEqual([]);
  });
  it("flags quantity differences, quotes never ordered, duplicate and missing numbers", () => {
    expect(kinds("QTY_MISMATCH").map((w) => w.rowNum)).toEqual([5, 13]);
    expect(kinds("QUOTED_NOT_ORDERED")[0].message).toMatch(/^2\.4 Gala Dinner: an estimate of AED 200 per unit/);
    expect(kinds("DUPLICATE_REF")[0].message).toBe("Line number 2.4 is used twice (rows 14 and 16).");
    expect(kinds("MISSING_REF").map((w) => w.rowNum)).toEqual([15]);
  });
  it("names an included line no product matched", () => {
    const bare = planBudgetSheet(parsed, { products: [], countInternalCost: true });
    expect(bare.warnings.filter((w) => w.kind === "UNMAPPED")).toHaveLength(9);
  });
  it("reads the agreed income and result below the totals, and compares them with last year", () => {
    expect(kinds("RESULT_ON_FOOTER").map((w) => w.message)).toEqual([
      "Below the totals the sheet records income of AED 40,000 and a result of AED 5,950 (14.88%). The billed column (AED 46,903) is the price, not what was earned.",
      "Against 2026: income +5.26%, cost +13.5%, result -25.63% (AED 8,000 then, AED 5,950 now).",
    ]);
  });
  it("orders the warnings by row", () => {
    const rows = plan.warnings.map((w) => w.rowNum);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
  });
});
