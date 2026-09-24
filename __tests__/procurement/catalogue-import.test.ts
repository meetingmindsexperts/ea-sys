/**
 * The pure halves of the two CSV imports: what a file must contain to be
 * read, which rows are refused and why, and, against what the organisation
 * already holds, which rows create, update or are skipped. Nothing here
 * touches a database; the services only execute these plans.
 */
import { describe, it, expect } from "vitest";
import {
  PRODUCT_IMPORT_COLUMNS,
  SUPPLIER_IMPORT_COLUMNS,
  importTemplateCsv,
  parseActiveCell,
  parseProductImport,
  parseSupplierImport,
  planProductImport,
  planSupplierImport,
} from "@/procurement/lib/catalogue-import";

describe("parseProductImport", () => {
  it("reads rows, matches headers regardless of case and spacing, strips a BOM and defaults active to yes", () => {
    const r = parseProductImport("﻿SKU, Name ,CATEGORY,Active\n510399,LED wall,av,\n510400,Stage,PRINT,no\n");
    expect(r.fatal).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.totalRows).toBe(2);
    expect(r.rows).toEqual([
      { rowNum: 2, sku: "510399", name: "LED wall", categoryCode: "AV", active: true },
      { rowNum: 3, sku: "510400", name: "Stage", categoryCode: "PRINT", active: false },
    ]);
  });
  it("is fatal without a header row or a required column", () => {
    expect(parseProductImport("").fatal).toBe("The file is empty.");
    expect(parseProductImport("sku,name,category\n").fatal).toMatch(/header row/);
    expect(parseProductImport("sku\n1\n").fatal).toBe("Missing column: name.");
    // The category column is optional: an account-number SKU takes its account group.
    expect(parseProductImport("sku,name\n510323,LED wall\n").rows).toEqual([{ rowNum: 2, sku: "510323", name: "LED wall", categoryCode: "", active: true }]);
  });
  it("refuses a row per rule and keeps going", () => {
    const r = parseProductImport(["sku,name,category,active", "510399,LED wall,AV,maybe", ",Stage,PRINT,", "bad sku!,X,AV,", "510399,Again,AV,", "510401,Fine,AV,yes"].join("\n"));
    expect(r.errors).toEqual([
      'Row 2: active must be yes or no, got "maybe".',
      "Row 3: sku and name are required.",
      'Row 4: SKU "bad sku!" may only hold letters, digits, dots, dashes and underscores (max 40).',
      'Row 5: SKU "510399" appears earlier in the file.',
    ]);
    expect(r.rows.map((x) => x.sku)).toEqual(["510401"]);
    expect(r.totalRows).toBe(5);
  });
  it("parseActiveCell accepts the usual spellings and refuses the rest", () => {
    for (const v of ["", "yes", "Y", "TRUE", "1", "active"]) expect(parseActiveCell(v)).toBe(true);
    for (const v of ["no", "N", "false", "0", "archived", "Inactive"]) expect(parseActiveCell(v)).toBe(false);
    expect(parseActiveCell("perhaps")).toBeNull();
  });
});

describe("planProductImport", () => {
  const categories = [{ id: "c-av", code: "AV" }, { id: "c-print", code: "PRINT" }];
  const existing = [{ id: "p1", sku: "510399", name: "LED wall", categoryId: "c-av", isActive: true }];
  it("creates a new SKU, updates a changed one, counts an identical one as unchanged, refuses an unknown category", () => {
    const plan = planProductImport(
      [
        { rowNum: 2, sku: "510399", name: "LED wall", categoryCode: "AV", active: true },
        { rowNum: 3, sku: "510399", name: "LED wall 6x3", categoryCode: "PRINT", active: false },
        { rowNum: 4, sku: "510500", name: "New thing", categoryCode: "av", active: false },
        { rowNum: 5, sku: "510501", name: "Lost", categoryCode: "NOPE", active: true },
      ],
      existing,
      categories,
    );
    expect(plan.unchanged).toBe(1);
    expect(plan.updates).toEqual([{ rowNum: 3, productId: "p1", sku: "510399", changes: { name: "LED wall 6x3", categoryId: "c-print", isActive: false } }]);
    expect(plan.creates).toEqual([{ rowNum: 4, sku: "510500", name: "New thing", categoryId: "c-av", active: false }]);
    expect(plan.errors).toEqual(['Row 5: unknown category code "NOPE".']);
  });
  it("only carries the fields that differ on an update", () => {
    const plan = planProductImport([{ rowNum: 2, sku: "510399", name: "LED wall", categoryCode: "AV", active: false }], existing, categories);
    expect(plan.updates[0].changes).toEqual({ isActive: false });
  });
  it("files an account-number SKU under its account group, refuses a contradicting code and needs a code otherwise", () => {
    const chart = [{ id: "c-510300", code: "510300" }, { id: "c-500900", code: "500900" }];
    const plan = planProductImport(
      [
        { rowNum: 2, sku: "510323", name: "LED wall", categoryCode: "", active: true },
        { rowNum: 3, sku: "510324", name: "Stage", categoryCode: "510300", active: true },
        { rowNum: 4, sku: "510325", name: "Truss", categoryCode: "500900", active: true },
        { rowNum: 5, sku: "LED-01", name: "Screen", categoryCode: "", active: true },
        { rowNum: 6, sku: "LED-02", name: "Screen", categoryCode: "500900", active: true },
      ],
      [],
      chart,
    );
    expect(plan.creates.map((c) => [c.sku, c.categoryId])).toEqual([["510323", "c-510300"], ["510324", "c-510300"], ["LED-02", "c-500900"]]);
    expect(plan.errors).toEqual([
      'Row 4: SKU 510325 belongs to account group 510300, not "500900". Leave the category blank.',
      "Row 5: SKU LED-01 is not an account number with a category of its own, so the category is required.",
    ]);
  });
});

describe("parseSupplierImport", () => {
  it("reads a full row, defaults the currency to AED, assembles the contact and uppercases the code", () => {
    const r = parseSupplierImport("legalName,displayName,code,billingLine1,billingLine2,billingCity,billingRegion,billingPostalCode,country,currency,taxRegistrationNo,paymentTerms,phone,accountsEmail,contactName,contactEmail,contactPhone,contactRole,notes\nGulf Audio Visual LLC,Gulf AV,gulfav,Office 12,Al Quoz 3,Dubai,Dubai,00000,AE,,100123,30 days,+971 4 111 1111,Accounts@GulfAV.example,Amal,amal@gulfav.example,+971 4 000 0000,Account manager,Preferred\n");
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      {
        rowNum: 2,
        legalName: "Gulf Audio Visual LLC",
        displayName: "Gulf AV",
        code: "GULFAV",
        billingLine1: "Office 12",
        billingLine2: "Al Quoz 3",
        billingCity: "Dubai",
        billingRegion: "Dubai",
        billingPostalCode: "00000",
        country: "AE",
        currency: "AED",
        taxRegistrationNo: "100123",
        paymentTerms: "30 days",
        phone: "+971 4 111 1111",
        accountsEmail: "accounts@gulfav.example",
        contacts: [{ name: "Amal", email: "amal@gulfav.example", phone: "+971 4 000 0000", role: "Account manager" }],
        notes: "Preferred",
      },
    ]);
  });
  it("refuses a malformed accounts email and an over-long postal code, and keeps a blank one empty", () => {
    const r = parseSupplierImport(["legalName,accountsEmail,billingPostalCode", "Acme,not-an-email,", "Beta,,123456789012345678901", "Gamma,,"].join("\n"));
    expect(r.errors).toEqual([expect.stringMatching(/^Row 2: accountsEmail: /), expect.stringMatching(/^Row 3: billingPostalCode: /)]);
    expect(r.rows.map((x) => [x.legalName, x.accountsEmail ?? null])).toEqual([["Gamma", null]]);
  });
  it("needs only the legal name; the optional columns may be absent from the file", () => {
    const r = parseSupplierImport("legalName\nAcme\n");
    expect(r.fatal).toBeUndefined();
    expect(r.rows[0]).toMatchObject({ legalName: "Acme", currency: "AED", contacts: undefined, code: undefined });
  });
  it("refuses a contact without a name, a bad email, a bad currency and duplicates inside the file", () => {
    const r = parseSupplierImport(["legalName,currency,contactName,contactEmail,code", "Acme,AED,,a@b.c,", "Beta,AED,Bo,not-an-email,", "Gamma,DIRHAMS,,,", "Delta,AED,,,D1", "Delta,AED,,,D2", "Epsilon,AED,,,d1", "Zeta,AED,,,"].join("\n"));
    expect(r.errors).toEqual([
      "Row 2: contactName is required when a contact email, phone or role is given.",
      expect.stringMatching(/^Row 3: contacts: /),
      expect.stringMatching(/^Row 4: currency: /),
      'Row 6: "Delta" appears earlier in the file.',
      'Row 7: code "D1" appears earlier in the file.',
    ]);
    expect(r.rows.map((x) => x.legalName)).toEqual(["Delta", "Zeta"]);
  });
});

describe("planSupplierImport", () => {
  const existing = [{ code: "ACME", legalName: "Acme Trading LLC" }];
  it("skips a row whose code or legal name already exists (case-insensitive) and creates the rest", () => {
    const plan = planSupplierImport(
      [
        { rowNum: 2, legalName: "Something", code: "acme", currency: "AED" },
        { rowNum: 3, legalName: "acme trading llc ", currency: "AED" },
        { rowNum: 4, legalName: "Fresh Co", currency: "AED" },
      ],
      existing,
    );
    expect(plan.skipped).toEqual([
      { rowNum: 2, reason: "code ACME already exists (Acme Trading LLC)" },
      { rowNum: 3, reason: '"acme trading llc " already exists as ACME' },
    ]);
    expect(plan.creates.map((r) => r.legalName)).toEqual(["Fresh Co"]);
  });
});

describe("importTemplateCsv", () => {
  it("is the column names then one sample row, in order, and every sample re-parses", () => {
    const t = importTemplateCsv(PRODUCT_IMPORT_COLUMNS);
    expect(t.split("\n")[0]).toBe("sku,name,category,active");
    expect(parseProductImport(t).errors).toEqual([]);
    const s = importTemplateCsv(SUPPLIER_IMPORT_COLUMNS);
    expect(s.split("\n")[0].startsWith("legalName,displayName,code,")).toBe(true);
    expect(parseSupplierImport(s).errors).toEqual([]);
  });
});
