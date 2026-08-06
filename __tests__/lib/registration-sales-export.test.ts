/**
 * The sales export is a PROJECTION of the full export, not a second row
 * builder — so the two files can never disagree about what someone paid or
 * which promo code they used. These pin that relationship.
 */
import { describe, it, expect } from "vitest";
import {
  REGISTRATION_EXPORT_HEADERS,
  REGISTRATION_SALES_COLUMNS,
  REGISTRATION_SALES_COLUMN_INDEXES,
  toSalesExportRow,
} from "@/lib/registration-export";

describe("sales export projection", () => {
  it("every sales column exists in the full export", () => {
    for (const name of REGISTRATION_SALES_COLUMNS) {
      expect(REGISTRATION_EXPORT_HEADERS).toContain(name);
    }
  });

  it("carries what the sales team asked for", () => {
    // The literal ask: who they are, which company, did they pay, what code.
    for (const needed of [
      "First Name", "Last Name", "Email", "Payer", "Payment Status", "Promo Code",
    ]) {
      expect(REGISTRATION_SALES_COLUMNS as readonly string[]).toContain(needed);
    }
  });

  it("never carries a door credential or personal detail sales shouldn't hold", () => {
    for (const forbidden of ["DTCM Barcode", "Bio", "Phone"]) {
      expect(REGISTRATION_SALES_COLUMNS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("picks the value that sits under each header, not a shifted one", () => {
    // A full row whose every cell names its own column: if an index is off by
    // one, the projected value won't match its header.
    const fullRow = REGISTRATION_EXPORT_HEADERS.map((h) => `value:${h}`);
    const projected = toSalesExportRow(fullRow);

    expect(projected).toHaveLength(REGISTRATION_SALES_COLUMNS.length);
    REGISTRATION_SALES_COLUMNS.forEach((name, i) => {
      expect(projected[i]).toBe(`value:${name}`);
    });
  });

  it("a redacted (empty) cell projects as empty, never as a wrong number", () => {
    // Non-finance callers get money columns blanked upstream; the projection
    // must pass that through rather than substitute anything.
    const fullRow = REGISTRATION_EXPORT_HEADERS.map((h) =>
      ["Total Paid", "Discount", "Payer"].includes(h) ? "" : `value:${h}`,
    );
    const projected = toSalesExportRow(fullRow);
    const at = (name: string) =>
      projected[(REGISTRATION_SALES_COLUMNS as readonly string[]).indexOf(name)];

    expect(at("Total Paid")).toBe("");
    expect(at("Payer")).toBe("");
    expect(at("Email")).toBe("value:Email");
  });

  it("tolerates a short row without inventing values", () => {
    expect(toSalesExportRow([])).toEqual(
      REGISTRATION_SALES_COLUMNS.map(() => ""),
    );
  });

  it("resolved every column index at module load", () => {
    expect(REGISTRATION_SALES_COLUMN_INDEXES).toHaveLength(
      REGISTRATION_SALES_COLUMNS.length,
    );
    expect(REGISTRATION_SALES_COLUMN_INDEXES.every((i) => i >= 0)).toBe(true);
  });
});
