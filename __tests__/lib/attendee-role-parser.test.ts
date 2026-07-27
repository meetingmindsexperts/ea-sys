/**
 * Shared AttendeeRole CSV parser.
 *
 * `role` (the profession category) used to be parsed ONLY by the registrations
 * importer — the speakers and contacts importers silently dropped the column,
 * and the downloadable templates didn't even offer it. One parser now backs all
 * three, so the acceptance rules can't diverge again.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseAttendeeRole, parseTitle, ATTENDEE_ROLE_ORDER } from "@/lib/schemas";

describe("parseAttendeeRole", () => {
  it("accepts every canonical enum value", () => {
    for (const role of ATTENDEE_ROLE_ORDER) {
      expect(parseAttendeeRole(role)).toBe(role);
    }
  });

  it("accepts the human labels operators actually type", () => {
    expect(parseAttendeeRole("Physician")).toBe("PHYSICIAN");
    expect(parseAttendeeRole("Allied Health")).toBe("ALLIED_HEALTH");
    expect(parseAttendeeRole("allied-health")).toBe("ALLIED_HEALTH");
    expect(parseAttendeeRole("Medical Devices")).toBe("MEDICAL_DEVICES");
  });

  it("tolerates surrounding whitespace from spreadsheet cells", () => {
    expect(parseAttendeeRole("  Physician  ")).toBe("PHYSICIAN");
  });

  it("returns null for empty / missing cells", () => {
    expect(parseAttendeeRole("")).toBeNull();
    expect(parseAttendeeRole(null)).toBeNull();
    expect(parseAttendeeRole(undefined)).toBeNull();
    expect(parseAttendeeRole("   ")).toBeNull();
  });

  // A typo must not fail the whole row — role is optional.
  it("returns null for an unrecognized value rather than throwing", () => {
    expect(parseAttendeeRole("Doctor")).toBeNull();
    expect(parseAttendeeRole("PHYSICIAN_X")).toBeNull();
  });
});

/**
 * Template/importer parity: every entity whose importer reads `role` must also
 * OFFER the column in its downloadable template, otherwise the field stays
 * invisible to operators (exactly how it stayed unused on registrations).
 *
 * The template is now ONE ordered list per entity carrying name+sample+required
 * together, so header/sample misalignment is impossible by construction — this
 * asserts the columns are present and the identity fields stay grouped.
 */
describe("CSV templates", () => {
  const src = readFileSync("src/components/import/csv-import-dialog.tsx", "utf8");

  function columnsFor(entity: string): string[] {
    const block = new RegExp(`${entity}: \\[([\\s\\S]*?)\\n  \\],`).exec(src);
    expect(block, `${entity} column list not found`).toBeTruthy();
    return [...block![1].matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
  }

  it("offers role on the importers that read it", () => {
    expect(columnsFor("registrations")).toContain("role");
    expect(columnsFor("speakers")).toContain("role");
  });

  it("groups the person-identity columns first", () => {
    for (const entity of ["registrations", "speakers"]) {
      expect(columnsFor(entity).slice(0, 5)).toEqual([
        "title",
        "firstName",
        "lastName",
        "email",
        "phone",
      ]);
    }
  });

  it("declares no duplicate columns", () => {
    for (const entity of ["registrations", "speakers", "sessions", "abstracts"]) {
      const cols = columnsFor(entity);
      expect(new Set(cols).size, `${entity} has duplicate columns`).toBe(cols.length);
    }
  });
});

describe("parseTitle", () => {
  it("accepts every Title enum value", () => {
    for (const t of ["DR", "MR", "MRS", "MS", "PROF"]) {
      expect(parseTitle(t)).toBe(t);
    }
  });

  it("accepts what operators type, including the UI's trailing period", () => {
    expect(parseTitle("Dr")).toBe("DR");
    expect(parseTitle("Dr.")).toBe("DR");
    expect(parseTitle(" prof ")).toBe("PROF");
  });

  it("returns null for empty or unrecognized values", () => {
    expect(parseTitle("")).toBeNull();
    expect(parseTitle(null)).toBeNull();
    expect(parseTitle("Sir")).toBeNull();
  });
});

describe("contacts CSV template", () => {
  it("groups identity columns first and offers title + role", () => {
    const src = readFileSync("src/app/(dashboard)/contacts/page.tsx", "utf8");
    const header = /"(title,firstName[^"]*)"/.exec(src);
    expect(header, "contacts template header not found").toBeTruthy();
    const cols = header![1].split(",");
    expect(cols.slice(0, 5)).toEqual(["title", "firstName", "lastName", "email", "phone"]);
    expect(cols).toContain("role");
  });
});
