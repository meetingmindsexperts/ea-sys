/**
 * The ProcurementExpress history reader (docs/BUDGET_AI_PLAN.md section 2a).
 * Every row here is INVENTED: the real export holds personal data and is never
 * a fixture (plan 2a.4). The rows copy its shape and its quirks.
 */
import { describe, expect, it } from "vitest";
import {
  INDIVIDUAL_SUPPLIER_LABEL,
  parsePxAmount,
  parsePxLineExport,
  planPxImport,
  pxAccountCode,
  pxEventKey,
  pxEventYear,
  type PxEventTarget,
} from "@/procurement/lib/px-import";

const HEADER = [
  "Purchase-Order-ID", "Purchase-Order-Line#", "Date", "Submitter", "Approvers", "Notes", "Supplier", "Status",
  "PO-Currency", "Item-Number-SKU", "Description", "Quantity", "Unit-Price-in-PO-ccy", "Tax%", "Tax-Amount-in-PO-ccy",
  "Gross-Amount-in-PO-ccy", "Net-Amount-in-PO-ccy", "AED-Gross-Amount", "AED-Net-Amount", "Foreign-Currency-Amount",
  "PO-Number", "Fulfillment-Date", "Budget", "Cost-Code", "Cost-Type", "Received-Quantity", "Total-Paid-Amount",
  "Archived", "Remaining Amount", "Department", "Payment-Date", "QuickBooks Class", "Vat 5%", "Class", "Narration",
];

interface Row {
  po: string;
  line?: string;
  date?: string;
  supplier?: string;
  status?: string;
  ccy?: string;
  sku?: string;
  desc?: string;
  tax?: number;
  gross: number;
  net: number;
  aedNet: number;
  aedGross?: number;
  budget: string;
  paid?: number;
  payDate?: string;
  qbClass?: string;
  notes?: string;
  submitter?: string;
}

function q(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows: Row[]): string {
  const body = rows.map((r) => {
    const cells: Record<string, string | number> = {
      "Purchase-Order-ID": r.po,
      "Purchase-Order-Line#": r.line ?? "1",
      Date: r.date ?? "2025-03-01",
      Submitter: r.submitter ?? "Staff Member",
      Approvers: "Approver Person",
      Notes: r.notes ?? "",
      Supplier: r.supplier ?? "Hotel Example LLC",
      Status: r.status ?? "approved",
      "PO-Currency": r.ccy ?? "AED",
      "Item-Number-SKU": r.sku ?? "510401 Day Delegate Rate",
      Description: r.desc ?? "Day Delegate Rate",
      Quantity: 1,
      "Unit-Price-in-PO-ccy": r.net,
      "Tax%": r.tax ?? 0,
      "Tax-Amount-in-PO-ccy": 0,
      "Gross-Amount-in-PO-ccy": r.gross,
      "Net-Amount-in-PO-ccy": r.net,
      "AED-Gross-Amount": r.aedGross ?? r.gross,
      "AED-Net-Amount": `AED ${Number.isInteger(r.aedNet) ? r.aedNet.toFixed(1) : r.aedNet}`,
      "Foreign-Currency-Amount": `${r.ccy ?? "AED"} ${r.gross}`,
      "PO-Number": `MM-${r.po}`,
      Budget: r.budget,
      "Total-Paid-Amount": r.paid ?? 0,
      "Remaining Amount": r.gross - (r.paid ?? 0),
      "Payment-Date": r.payDate ?? "",
      "QuickBooks Class": r.qbClass ?? "",
      Narration: "narration text",
    };
    return HEADER.map((h) => q(cells[h] ?? "")).join(",");
  });
  return [HEADER.join(","), ...body].join("\n");
}

const event = (id: string, startDate: string | null = null): PxEventTarget => ({ kind: "event", id, label: id, startDate });

describe("parsePxAmount", () => {
  it.each([
    ["11620", 11620],
    ["AED 11620.0", 11620],
    ["USD 680.73", 680.73],
    ["1,499.99", 1499.99],
    ["-510", -510],
    ["(510.00)", -510],
  ])("reads %s", (raw, want) => expect(parsePxAmount(raw)).toBe(want));

  it.each(["", "abc", "AED", "12.3.4", "aed 5"])("refuses %j rather than reading zero", (raw) => {
    expect(parsePxAmount(raw)).toBeNull();
  });
});

describe("event names and codes", () => {
  it("maps trivial spelling differences to one key", () => {
    expect(pxEventKey("1st Abu Dhabi Cardio Renal Forum - 2025")).toBe(pxEventKey(" 1st Abu Dhabi  Cardio Renal Forum 2025 "));
    expect(pxEventKey("Grifols – EHC Workshop")).toBe(pxEventKey("grifols - ehc workshop"));
  });

  it("does not merge a date range into the year", () => {
    expect(pxEventKey("Speaker Tour - 23-24 May 2025")).toBe("speaker tour - 23-24 may 2025");
  });

  it("reads the year and the account code", () => {
    expect(pxEventYear("Conference:MEHFC 2024")).toBe(2024);
    expect(pxEventYear("MME")).toBeNull();
    expect(pxAccountCode("510203 Speaker Air Ticket")).toBe("510203");
    expect(pxAccountCode("")).toBeNull();
    expect(pxAccountCode("Round off")).toBeNull();
  });
});

describe("parsePxLineExport", () => {
  it("reads lines and the file's date range", () => {
    const r = parsePxLineExport(
      "﻿" +
        csv([
          { po: "1001", date: "2025-02-10", gross: 100, net: 100, aedNet: 100, budget: "EVA 2025" },
          { po: "1002", date: "2025-01-05", gross: 50, net: 50, aedNet: 50, budget: "EVA 2025" },
        ]),
    );
    expect(r.fatal).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.lines).toHaveLength(2);
    expect(r.range).toEqual({ from: "2025-01-05", to: "2025-02-10" });
    expect(r.lines[0]).toMatchObject({ poId: "1001", aedNet: 100, status: "approved", budgetNames: ["EVA 2025"] });
  });

  it("never carries the personal-data columns", () => {
    const r = parsePxLineExport(
      csv([{ po: "1001", gross: 1, net: 1, aedNet: 1, budget: "EVA 2025", notes: "passport_A1234567.pdf", submitter: "Jane Staff" }]),
    );
    const text = JSON.stringify(r);
    expect(text).not.toContain("passport");
    expect(text).not.toContain("Jane Staff");
    expect(text).not.toContain("narration text");
    expect(text).not.toContain("Approver Person");
  });

  it("refuses the order-level report by name", () => {
    const r = parsePxLineExport("Date,Supplier,Status,AED-Total-Net,AED-Total-Gross,Purchase-Order-ID\n2025-01-01,X,paid,1,1,9");
    expect(r.fatal).toMatch(/order-level report/);
  });

  it("names the missing columns of an unrelated file", () => {
    const r = parsePxLineExport("name,amount\nx,1");
    expect(r.fatal).toMatch(/Missing columns: .*Purchase-Order-ID/);
  });

  it("reports an unreadable amount or date by row and keeps the rest", () => {
    const text = csv([
      { po: "1001", gross: 1, net: 1, aedNet: 1, budget: "EVA 2025" },
      { po: "1002", gross: 1, net: 1, aedNet: 1, budget: "EVA 2025" },
      { po: "1003", date: "03/01/2025", gross: 1, net: 1, aedNet: 1, budget: "EVA 2025" },
    ]).replace("AED 1.0", "AED one");
    const r = parsePxLineExport(text);
    expect(r.lines.map((l) => l.poId)).toEqual(["1002"]);
    expect(r.errors).toEqual([
      { rowNum: 2, message: expect.stringMatching(/AED-Net-Amount "AED one" is not an amount/) },
      { rowNum: 4, message: expect.stringMatching(/not YYYY-MM-DD/) },
    ]);
  });

  it("refuses the same order line twice", () => {
    const r = parsePxLineExport(csv([
      { po: "1001", gross: 1, net: 1, aedNet: 1, budget: "EVA 2025" },
      { po: "1001", gross: 1, net: 1, aedNet: 1, budget: "EVA 2025" },
    ]));
    expect(r.lines).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/appears twice/);
  });

  it("reads a quoted Notes cell with commas and line breaks as one row", () => {
    const r = parsePxLineExport(csv([{ po: "1001", gross: 1, net: 1, aedNet: 1, budget: "EVA 2025", notes: "a, b\nc \"d\"" }]));
    expect(r.errors).toEqual([]);
    expect(r.lines).toHaveLength(1);
  });

  it("splits a two-event Budget cell", () => {
    const r = parsePxLineExport(csv([{ po: "1001", gross: 1, net: 1, aedNet: 1, budget: "EVA 2025,EVB 2025" }]));
    expect(r.lines[0].budgetNames).toEqual(["EVA 2025", "EVB 2025"]);
  });
});

function plan(rows: Row[], eventMap: Map<string, PxEventTarget> = new Map(), knownSuppliers?: Set<string>) {
  const parsed = parsePxLineExport(csv(rows));
  expect(parsed.fatal).toBeUndefined();
  expect(parsed.errors).toEqual([]);
  return planPxImport(parsed, { eventMap, knownSuppliers });
}

describe("planPxImport: which lines count", () => {
  it("counts approved and paid in any case, and counts the rest as dropped", () => {
    const p = plan([
      { po: "1", status: "approved", gross: 10, net: 10, aedNet: 10, budget: "EVA 2025" },
      { po: "2", status: "Paid", gross: 10, net: 10, aedNet: 10, paid: 10, budget: "EVA 2025" },
      { po: "3", status: "paid", gross: 10, net: 10, aedNet: 10, paid: 10, budget: "EVA 2025" },
      { po: "4", status: "cancelled", gross: 10, net: 10, aedNet: 10, budget: "EVA 2025" },
      { po: "5", status: "rejected", gross: 10, net: 10, aedNet: 10, budget: "EVA 2025" },
      { po: "6", status: "pending", gross: 10, net: 10, aedNet: 10, budget: "EVA 2025" },
      { po: "7", status: "draft", gross: 10, net: 10, aedNet: 10, budget: "EVA 2025" },
    ]);
    expect(p.lines.map((l) => l.poId)).toEqual(["1", "2", "3"]);
    expect(p.dropped.byStatus).toEqual({ cancelled: 1, rejected: 1, pending: 1, draft: 1 });
  });

  it("leaves out overhead and balance-sheet accounts, and Not an event", () => {
    const p = plan(
      [
        { po: "1", sku: "600601 Software", gross: 10, net: 10, aedNet: 10, budget: "Office" },
        { po: "2", sku: "220004 Deposit", gross: 10, net: 10, aedNet: 10, budget: "EVA 2025" },
        { po: "3", sku: "", gross: 10, net: 10, aedNet: 10, budget: "Office" },
        { po: "4", gross: 10, net: 10, aedNet: 10, budget: "" },
        { po: "5", gross: 10, net: 10, aedNet: 10, budget: "EVA 2025" },
      ],
      new Map([[pxEventKey("Office"), { kind: "not-event" }]]),
    );
    expect(p.lines.map((l) => l.poId)).toEqual(["5"]);
    expect(p.dropped).toMatchObject({ notEventSpend: 2, notAnEvent: 1, noEvent: 1 });
  });
});

describe("planPxImport: amounts and evidence", () => {
  it("uses AED net and derives PX's own rate", () => {
    const p = plan([{ po: "1", ccy: "USD", gross: 1000, net: 1000, aedNet: 3672.5, budget: "EVA 2025" }]);
    expect(p.lines[0]).toMatchObject({ committedAed: 3672.5, rateToAed: 3.6725, evidence: "committed", paidAed: 0 });
  });

  it("converts a gross, order-currency payment to AED ex-VAT", () => {
    const p = plan([{ po: "1", status: "Paid", tax: 5, gross: 1050, net: 1000, aedNet: 1000, paid: 525, budget: "EVA 2025" }]);
    expect(p.lines[0]).toMatchObject({ evidence: "paid", paidAed: 500 });
  });

  it("caps an overpayment by rounding at the whole line", () => {
    const p = plan([{ po: "1", status: "Paid", ccy: "USD", gross: 680.73, net: 680.73, aedNet: 2499.98, paid: 681.76, budget: "EVA 2025" }]);
    expect(p.lines[0].paidAed).toBe(2499.98);
  });

  it("treats paid-with-nothing-paid as committed", () => {
    const p = plan([{ po: "1", status: "Paid", gross: 100, net: 100, aedNet: 100, paid: 0, budget: "EVA 2025" }]);
    expect(p.lines[0]).toMatchObject({ evidence: "committed", paidAed: 0 });
  });

  it("flags VAT unclear and still pays against the true gross", () => {
    const p = plan([{ po: "1", status: "Paid", tax: 5, gross: 1200, net: 1200, aedGross: 1260, aedNet: 1200, paid: 630, budget: "EVA 2025" }]);
    expect(p.lines[0].flags).toContain("vat-unclear");
    expect(p.lines[0].paidAed).toBe(600);
  });

  it("keeps a credit line and nets it off", () => {
    const p = plan([
      { po: "1", gross: 1000, net: 1000, aedNet: 1000, budget: "EVA 2025" },
      { po: "1", line: "2", gross: -510, net: -510, aedNet: -510, budget: "EVA 2025" },
    ]);
    expect(p.lines[1].flags).toContain("credit");
    expect(p.events[0].byCategory["510400"]).toEqual({ committedAed: 490, paidAed: 0, lines: 2 });
  });

  it("splits a two-event line evenly and flags it", () => {
    const p = plan([{ po: "1", gross: 1000, net: 1000, aedNet: 1000, budget: "EVA 2025,EVB 2025" }]);
    expect(p.lines.map((l) => [l.eventName, l.committedAed, l.flags.includes("shared")])).toEqual([
      ["EVA 2025", 500, true],
      ["EVB 2025", 500, true],
    ]);
  });
});

describe("planPxImport: categories", () => {
  it("maps by account group and suggests one for an uncoded fee line", () => {
    const p = plan([
      { po: "1", sku: "510401 Day Delegate Rate", gross: 1000, net: 1000, aedNet: 1000, budget: "EVA 2025" },
      { po: "1", line: "2", sku: "500501 Coffee", gross: 100, net: 100, aedNet: 100, budget: "EVA 2025" },
      { po: "1", line: "3", sku: "", desc: "Municipality Fees 7%", gross: 77, net: 77, aedNet: 77, budget: "EVA 2025" },
      { po: "2", sku: "", desc: "Round off", gross: 1, net: 1, aedNet: 1, budget: "EVA 2025" },
    ]);
    expect(p.lines.map((l) => [l.categoryCode, l.suggestedCategoryCode])).toEqual([
      ["510400", null],
      ["500500", null],
      [null, "510400"],
      [null, null],
    ]);
    expect(p.events[0].byCategory.UNMAPPED).toEqual({ committedAed: 78, paidAed: 0, lines: 2 });
  });

  it("warns when the QuickBooks class names another year", () => {
    const p = plan([{ po: "1", gross: 1, net: 1, aedNet: 1, budget: "MEHFC 2025", qbClass: "Conference:MEHFC 2024" }]);
    expect(p.lines[0].flags).toContain("class-mismatch");
  });
});

describe("planPxImport: personal data", () => {
  it("anonymises a person paid under speakers and faculty, keeps a registered supplier", () => {
    const p = plan(
      [
        { po: "1", sku: "510201 Honorarium", supplier: "Dr Invented Person", gross: 5000, net: 5000, aedNet: 5000, budget: "EVA 2025" },
        { po: "2", sku: "510203 Air Ticket", supplier: "Travel Agency LLC", gross: 900, net: 900, aedNet: 900, budget: "EVA 2025" },
        { po: "3", sku: "510401 DDR", supplier: "Dr Invented Person", gross: 10, net: 10, aedNet: 10, budget: "EVA 2025" },
      ],
      new Map(),
      new Set(["travel agency llc"]),
    );
    expect(p.lines.map((l) => l.supplier)).toEqual([INDIVIDUAL_SUPPLIER_LABEL, "Travel Agency LLC", "Dr Invented Person"]);
    expect(JSON.stringify(p.lines.slice(0, 2))).not.toContain("Invented");
  });
});

describe("planPxImport: events, coverage and duplicates", () => {
  const rows: Row[] = [
    { po: "1", date: "2025-01-02", status: "Paid", gross: 1000, net: 1000, aedNet: 1000, paid: 1000, budget: "EVA 2025" },
    { po: "2", date: "2025-07-28", gross: 3000, net: 3000, aedNet: 3000, budget: "EVA 2025" },
    { po: "3", gross: 50, net: 50, aedNet: 50, budget: "Old Event 2024" },
    { po: "4", gross: 70, net: 70, aedNet: 70, budget: "Unknown Meeting" },
  ];

  it("summarises per event with the share of spend recorded as paid", () => {
    const p = plan(rows);
    expect(p.events[0]).toMatchObject({ eventName: "EVA 2025", committedAed: 4000, paidAed: 1000, paidShare: 0.25, lineCount: 2 });
  });

  it("lists names with no mapping, largest first", () => {
    const p = plan(rows, new Map([[pxEventKey("EVA 2025"), event("eva")]]));
    expect(p.unmappedEvents.map((e) => e.eventName)).toEqual(["Unknown Meeting", "Old Event 2024"]);
  });

  it("marks coverage from the event date when known, else from the year in the name", () => {
    const p = plan(
      rows,
      new Map<string, PxEventTarget>([
        [pxEventKey("EVA 2025"), event("eva", "2025-10-10")],
      ]),
    );
    const byName = Object.fromEntries(p.events.map((e) => [e.eventName, e.coverage]));
    expect(byName).toEqual({ "EVA 2025": "partial", "Old Event 2024": "partial", "Unknown Meeting": "unknown" });
  });

  it("calls an event complete when the file spans a year before to three months after", () => {
    const parsed = parsePxLineExport(csv(rows));
    const p = planPxImport(
      { lines: parsed.lines, range: { from: "2024-01-01", to: "2026-06-30" } },
      { eventMap: new Map([[pxEventKey("EVA 2025"), event("eva", "2025-03-01")]]) },
    );
    expect(p.events.find((e) => e.eventName === "EVA 2025")?.coverage).toBe("complete");
  });

  it("lists same supplier and amount on different orders, never removes them", () => {
    const p = plan([
      { po: "10", supplier: "Venue Co", gross: 180000, net: 180000, aedNet: 180000, budget: "EVA 2025" },
      { po: "11", supplier: "Venue Co", gross: 180000, net: 180000, aedNet: 180000, budget: "EVA 2025" },
      { po: "12", line: "1", supplier: "Venue Co", gross: 5, net: 5, aedNet: 5, budget: "EVA 2025" },
      { po: "12", line: "2", supplier: "Venue Co", gross: 5, net: 5, aedNet: 5, budget: "EVA 2025" },
    ]);
    expect(p.possibleDuplicates).toEqual([{ eventKey: "eva 2025", supplier: "Venue Co", aedNet: 180000, poIds: ["10", "11"] }]);
    expect(p.lines).toHaveLength(4);
  });
});
