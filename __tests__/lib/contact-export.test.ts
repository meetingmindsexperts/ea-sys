/**
 * The contacts CSV export's column list (Oct 23, 2026): city and country were
 * missing because the select, headers and cells were three hand-kept lists.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_EXPORT_COLUMNS, EXPORT_COLUMNS, EXPORT_COLUMN_GROUPS, IMPORT_TEXT_COLUMNS, exportCell, parseExportColumns, parseImportDate } from "@/lib/contact-export";
import { readPrismaSchema } from "../../prisma/schema-text";

describe("contacts export columns", () => {
  it("includes the address and membership fields", () => {
    for (const col of ["city", "state", "zipCode", "country", "additionalEmail", "role", "associationName", "memberId"]) {
      expect(EXPORT_COLUMNS).toContain(col);
    }
  });

  it("names only real Contact columns", () => {
    const schema = readPrismaSchema();
    const model = schema.slice(schema.indexOf("model Contact {"));
    const body = model.slice(0, model.indexOf("\n}"));
    for (const col of EXPORT_COLUMNS) expect(body).toMatch(new RegExp(`\\n\\s+${col}\\s`));
  });

  it("formats cells: null stays empty, arrays join, dates are YYYY-MM-DD", () => {
    expect(exportCell(null)).toBeNull();
    expect(exportCell(["vip", "faculty"])).toBe("vip,faculty");
    expect(exportCell(new Date("2026-10-23T15:00:00Z"))).toBe("2026-10-23");
    expect(exportCell("Dubai")).toBe("Dubai");
  });
});

describe("parseExportColumns", () => {
  it("absent means every column, so older API callers keep their file", () => {
    const r = parseExportColumns(null);
    expect(r.ok && r.columns).toEqual([...EXPORT_COLUMNS]);
  });

  it("returns the chosen columns in file order, whatever the request order", () => {
    const r = parseExportColumns("country, email,firstName");
    expect(r.ok && r.columns).toEqual(["firstName", "email", "country"]);
  });

  it("refuses an unknown column instead of quietly dropping it", () => {
    const r = parseExportColumns("email,password,photo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unknown).toEqual(["password", "photo"]);
  });

  it("refuses an empty choice", () => {
    expect(parseExportColumns("").ok).toBe(false);
    expect(parseExportColumns(" , ").ok).toBe(false);
  });
});

describe("dialog groups and defaults", () => {
  it("lists every export column exactly once", () => {
    const listed = EXPORT_COLUMN_GROUPS.flatMap((g) => g.columns.map((c) => c.key));
    expect([...listed].sort()).toEqual([...EXPORT_COLUMNS].sort());
  });

  it("the basic set leaves phone, bio, notes and ID numbers off", () => {
    for (const col of ["phone", "bio", "notes", "memberId", "studentId"] as const) {
      expect(DEFAULT_EXPORT_COLUMNS).not.toContain(col);
    }
    expect(DEFAULT_EXPORT_COLUMNS).toEqual(expect.arrayContaining(["city", "country", "email"]));
  });
});

describe("import columns", () => {
  it("every import text column is an export column", () => {
    for (const col of IMPORT_TEXT_COLUMNS) expect(EXPORT_COLUMNS).toContain(col);
  });

  it("parseImportDate takes real YYYY-MM-DD dates only", () => {
    expect(parseImportDate("2027-06-30")?.toISOString()).toBe("2027-06-30T00:00:00.000Z");
    expect(parseImportDate(" 2027-06-30 ")).not.toBeNull();
    expect(parseImportDate("2027-02-30")).toBeNull();
    expect(parseImportDate("30/06/2027")).toBeNull();
    expect(parseImportDate("")).toBeNull();
    expect(parseImportDate(undefined)).toBeNull();
  });
});
