import { describe, it, expect } from "vitest";
import {
  parseCSVLine,
  parseCSVHeaders,
  buildColumnIndex,
  getField,
  parseTags,
  parseCSV,
} from "@/lib/csv-parser";

// ── parseCSVLine ────────────────────────────────────────────────────

describe("parseCSVLine", () => {
  it("parses a simple comma-separated line", () => {
    expect(parseCSVLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("trims whitespace from fields", () => {
    expect(parseCSVLine("  hello , world , test ")).toEqual([
      "hello",
      "world",
      "test",
    ]);
  });

  it("handles quoted fields with commas", () => {
    expect(parseCSVLine('"Smith, John",email@test.com,Org')).toEqual([
      "Smith, John",
      "email@test.com",
      "Org",
    ]);
  });

  it("handles escaped double quotes inside quoted fields", () => {
    expect(parseCSVLine('"He said ""hello""",value')).toEqual([
      'He said "hello"',
      "value",
    ]);
  });

  it("handles empty fields", () => {
    expect(parseCSVLine("a,,c,")).toEqual(["a", "", "c", ""]);
  });

  it("handles a single field", () => {
    expect(parseCSVLine("hello")).toEqual(["hello"]);
  });

  it("handles empty string", () => {
    expect(parseCSVLine("")).toEqual([""]);
  });

  it("handles quoted field with newline-like content", () => {
    // Note: In real CSV, newlines are within the quoted field
    // but parseCSVLine only handles a single line
    expect(parseCSVLine('"multi line",normal')).toEqual([
      "multi line",
      "normal",
    ]);
  });

  it("handles mixed quoted and unquoted fields", () => {
    expect(parseCSVLine('plain,"quoted, with comma",another')).toEqual([
      "plain",
      "quoted, with comma",
      "another",
    ]);
  });
});

// ── parseCSVHeaders ─────────────────────────────────────────────────

describe("parseCSVHeaders", () => {
  it("normalizes headers to lowercase", () => {
    expect(parseCSVHeaders("FirstName,LastName,Email")).toEqual([
      "firstname",
      "lastname",
      "email",
    ]);
  });

  it("removes spaces from headers", () => {
    expect(parseCSVHeaders("First Name, Last Name, Job Title")).toEqual([
      "firstname",
      "lastname",
      "jobtitle",
    ]);
  });

  it("handles mixed case and spacing", () => {
    expect(parseCSVHeaders("Speaker Email, FIRST NAME,  bio ")).toEqual([
      "speakeremail",
      "firstname",
      "bio",
    ]);
  });
});

// ── buildColumnIndex ────────────────────────────────────────────────

describe("buildColumnIndex", () => {
  it("maps field names to header positions", () => {
    const headers = ["email", "firstname", "lastname", "organization"];
    const fields = ["email", "firstname", "lastname"] as const;
    const idx = buildColumnIndex(headers, fields);

    expect(idx.email).toBe(0);
    expect(idx.firstname).toBe(1);
    expect(idx.lastname).toBe(2);
  });

  it("returns -1 for missing columns", () => {
    const headers = ["email", "firstname"];
    const fields = ["email", "phone"] as const;
    const idx = buildColumnIndex(headers, fields);

    expect(idx.email).toBe(0);
    expect(idx.phone).toBe(-1);
  });

  it("handles empty headers", () => {
    const idx = buildColumnIndex([], ["email"] as const);
    expect(idx.email).toBe(-1);
  });
});

// ── getField ────────────────────────────────────────────────────────

describe("getField", () => {
  const row = ["John", " Doe ", "", "Acme Corp"];

  it("returns trimmed value at valid index", () => {
    expect(getField(row, 0)).toBe("John");
    expect(getField(row, 1)).toBe("Doe");
    expect(getField(row, 3)).toBe("Acme Corp");
  });

  it("returns undefined for empty string", () => {
    expect(getField(row, 2)).toBeUndefined();
  });

  it("returns undefined for negative index", () => {
    expect(getField(row, -1)).toBeUndefined();
  });

  it("returns undefined for out-of-bounds index", () => {
    expect(getField(row, 10)).toBeUndefined();
  });
});

// ── parseTags ───────────────────────────────────────────────────────

describe("parseTags", () => {
  it("splits comma-separated tags", () => {
    expect(parseTags("vip,speaker,sponsor")).toEqual([
      "vip",
      "speaker",
      "sponsor",
    ]);
  });

  it("trims whitespace from tags", () => {
    expect(parseTags(" tag1 , tag2 , tag3 ")).toEqual([
      "tag1",
      "tag2",
      "tag3",
    ]);
  });

  it("filters out empty entries", () => {
    expect(parseTags("tag1,,tag2,,,tag3")).toEqual(["tag1", "tag2", "tag3"]);
  });

  it("returns empty array for undefined", () => {
    expect(parseTags(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseTags("")).toEqual([]);
  });

  it("handles single tag", () => {
    expect(parseTags("vip")).toEqual(["vip"]);
  });
});

// ── parseCSV ────────────────────────────────────────────────────────

describe("parseCSV", () => {
  it("parses a valid CSV with header and data rows", () => {
    const csv = "Name,Email\nJohn,john@test.com\nJane,jane@test.com";
    const result = parseCSV(csv);

    expect(result.error).toBeUndefined();
    expect(result.headers).toEqual(["name", "email"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual(["John", "john@test.com"]);
    expect(result.rows[1]).toEqual(["Jane", "jane@test.com"]);
  });

  it("returns error for header-only CSV", () => {
    const result = parseCSV("Name,Email");
    expect(result.error).toBe(
      "CSV must have a header row and at least one data row"
    );
  });

  it("returns error for empty CSV", () => {
    const result = parseCSV("");
    expect(result.error).toBe(
      "CSV must have a header row and at least one data row"
    );
  });

  it("handles Windows-style line endings (CRLF)", () => {
    const csv = "Name,Email\r\nJohn,john@test.com\r\nJane,jane@test.com";
    const result = parseCSV(csv);

    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(2);
  });

  it("skips empty lines", () => {
    const csv = "Name,Email\n\nJohn,john@test.com\n\n\nJane,jane@test.com\n";
    const result = parseCSV(csv);

    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(2);
  });

  it("rejects CSV exceeding 5000 rows", () => {
    const header = "name,email";
    const rows = Array.from(
      { length: 5001 },
      (_, i) => `user${i},user${i}@test.com`
    );
    const csv = [header, ...rows].join("\n");
    const result = parseCSV(csv);

    expect(result.error).toContain("exceeds maximum of 5000 rows");
  });

  it("accepts CSV with exactly 5000 rows", () => {
    const header = "name,email";
    const rows = Array.from(
      { length: 5000 },
      (_, i) => `user${i},user${i}@test.com`
    );
    const csv = [header, ...rows].join("\n");
    const result = parseCSV(csv);

    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(5000);
  });

  it("handles quoted fields in data rows", () => {
    const csv = 'Name,Bio\nJohn,"Speaker, Author"\nJane,"PhD, Researcher"';
    const result = parseCSV(csv);

    expect(result.error).toBeUndefined();
    expect(result.rows[0]).toEqual(["John", "Speaker, Author"]);
    expect(result.rows[1]).toEqual(["Jane", "PhD, Researcher"]);
  });

  it("normalizes headers (lowercase, no spaces)", () => {
    const csv = "First Name,Last Name,Email Address\nJohn,Doe,j@t.com";
    const result = parseCSV(csv);

    expect(result.headers).toEqual(["firstname", "lastname", "emailaddress"]);
  });
});
