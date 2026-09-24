/**
 * The supplier CSV export (Sep 24, 2026). What it must guarantee:
 *   - the importable columns come first, under the import's names, in its order,
 *     so an exported file parses straight back through the REAL importer;
 *   - bank details can never appear: the builder has no field for them and the
 *     service read does not select the column;
 *   - no importable column is silently blank when the supplier has a value
 *     (the guard against a column added to the import and missed here);
 *   - extra contacts are kept, readable, in their own column;
 *   - a hostile cell cannot run as a spreadsheet formula.
 */
import { describe, it, expect } from "vitest";
import { buildSupplierCsv, SUPPLIER_EXPORT_HEADER, SUPPLIER_EXPORT_EXTRA_COLUMNS, supplierExportFilename, type SupplierExportInput } from "@/procurement/lib/supplier-export";
import { SUPPLIER_IMPORT_COLUMNS, parseSupplierImport } from "@/procurement/lib/catalogue-import";
import { parseCSV } from "@/lib/csv-parser";
import { SUPPLIER_EXPORT_SELECT } from "@/procurement/services/supplier-service";

const full: SupplierExportInput = {
  code: "GULFAV",
  legalName: "Gulf Audio Visual LLC",
  displayName: "Gulf AV",
  country: "AE",
  currency: "AED",
  taxRegistrationNo: "100123456700003",
  paymentTerms: "30 days",
  billingLine1: "Office 1204, Bay Square Building 3",
  billingLine2: "Business Bay",
  billingCity: "Dubai",
  billingRegion: "Dubai",
  billingPostalCode: "00000",
  phone: "+971 4 000 0000",
  accountsEmail: "accounts@gulfav.example",
  contacts: [
    { name: "Amal Haddad", email: "amal@gulfav.example", phone: "+971 4 000 0000", role: "Account manager" },
    { name: "Omar Said", email: "omar@gulfav.example" },
  ],
  notes: "Preferred for LED walls",
  approvalStatus: "APPROVED",
  isActive: true,
};

/** parseCSV lowercases headers, so look columns up the same way. */
function table(csv: string) {
  const parsed = parseCSV(csv);
  const col = (name: string) => parsed.headers.indexOf(name.toLowerCase());
  return { headers: { indexOf: col }, rows: parsed.rows };
}

describe("buildSupplierCsv", () => {
  it("leads with the import's columns, in the import's order, then the read-only extras", () => {
    const importNames = SUPPLIER_IMPORT_COLUMNS.map((c) => c.name);
    expect(SUPPLIER_EXPORT_HEADER.slice(0, importNames.length)).toEqual(importNames);
    expect(SUPPLIER_EXPORT_HEADER.slice(importNames.length)).toEqual([...SUPPLIER_EXPORT_EXTRA_COLUMNS]);
    // The raw first line, not the parser's lowercased view: the case is what a person sees in Excel.
    expect(buildSupplierCsv([full]).split("\n")[0]).toBe(SUPPLIER_EXPORT_HEADER.join(","));
  });

  it("round-trips: an exported file parses back through the real importer with no errors", () => {
    const back = parseSupplierImport(buildSupplierCsv([full, { ...full, code: "ACME", legalName: "Acme LLC", displayName: "Acme", contacts: [] }]));
    expect(back.fatal).toBeUndefined();
    expect(back.errors).toEqual([]);
    expect(back.rows).toHaveLength(2);
    expect(back.rows[0]).toMatchObject({
      code: "GULFAV", legalName: "Gulf Audio Visual LLC", displayName: "Gulf AV", country: "AE", currency: "AED",
      taxRegistrationNo: "100123456700003", paymentTerms: "30 days", notes: "Preferred for LED walls",
      billingLine1: "Office 1204, Bay Square Building 3", billingLine2: "Business Bay", billingCity: "Dubai",
      billingRegion: "Dubai", billingPostalCode: "00000", phone: "+971 4 000 0000", accountsEmail: "accounts@gulfav.example",
      contacts: [{ name: "Amal Haddad", email: "amal@gulfav.example", phone: "+971 4 000 0000", role: "Account manager" }],
    });
  });

  it("fills every importable column when the supplier has a value for it (catches a new import column missed here)", () => {
    const { headers, rows } = table(buildSupplierCsv([full]));
    for (const c of SUPPLIER_IMPORT_COLUMNS) {
      expect(rows[0][headers.indexOf(c.name)], `column ${c.name} was blank`).not.toBe("");
    }
  });

  it("keeps the first contact in the contact columns and every other one, readable, in additionalContacts", () => {
    const { headers, rows } = table(buildSupplierCsv([full]));
    expect(rows[0][headers.indexOf("contactName")]).toBe("Amal Haddad");
    expect(rows[0][headers.indexOf("additionalContacts")]).toBe("Omar Said <omar@gulfav.example>");
  });

  it("writes status and active as read-only columns", () => {
    const { headers, rows } = table(buildSupplierCsv([{ ...full, approvalStatus: "REJECTED", isActive: false }]));
    expect(rows[0][headers.indexOf("approvalStatus")]).toBe("REJECTED");
    expect(rows[0][headers.indexOf("active")]).toBe("no");
  });

  it("tolerates a contacts column that is not the expected shape", () => {
    for (const contacts of [null, "junk", { name: "x" }, [null, 3, { email: "no-name@x.example" }]]) {
      const { headers, rows } = table(buildSupplierCsv([{ ...full, contacts }]));
      expect(rows[0][headers.indexOf("contactName")]).toBe("");
      expect(rows[0][headers.indexOf("additionalContacts")]).toBe("");
    }
  });

  it("neutralises a formula in a cell, so opening the file cannot run it", () => {
    const csv = buildSupplierCsv([{ ...full, notes: "=HYPERLINK(\"http://evil.example\")" }]);
    expect(csv).not.toMatch(/,=HYPERLINK/);
    expect(csv).toContain("'=HYPERLINK");
  });

  it("writes the header alone for an empty master", () => {
    expect(buildSupplierCsv([])).toBe(`${SUPPLIER_EXPORT_HEADER.join(",")}\n`);
  });
});

describe("bank details never leave the system", () => {
  it("the service read feeding the export does not select them", () => {
    expect(SUPPLIER_EXPORT_SELECT).not.toHaveProperty("bankDetails");
  });
  it("no export column is named for them", () => {
    expect(SUPPLIER_EXPORT_HEADER.some((h) => /bank|iban|swift|accountno|accountnumber/i.test(h))).toBe(false);
  });
  it("a bankDetails value smuggled onto the input does not reach the file", () => {
    const smuggled = { ...full, bankDetails: { iban: "AE070331234567890123456" } } as SupplierExportInput;
    expect(buildSupplierCsv([smuggled])).not.toContain("AE070331234567890123456");
  });
});

describe("supplierExportFilename", () => {
  it("is dated in UTC", () => {
    expect(supplierExportFilename(new Date("2026-09-24T23:30:00Z"))).toBe("suppliers-2026-09-24.csv");
  });
});
