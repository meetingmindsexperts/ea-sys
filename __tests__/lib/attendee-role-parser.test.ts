/**
 * Reading a written Role answer (CSV cells, the contacts filter, the inbound
 * contacts_centralv1 import) through the ONE matcher, `answerKeyFor`, against
 * the organisation's own answers (step 1c of docs/ORG_FIELDS_PLAN.md).
 *
 * `role` (the profession category) used to be parsed ONLY by the registrations
 * importer: the speakers and contacts importers silently dropped the column,
 * and the downloadable templates did not offer it. One reader now backs all
 * three. These cases are the old fixed-list parser's, kept so nothing it read
 * stops being read, plus what it could not read.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseTitle, ATTENDEE_ROLE_ORDER } from "@/lib/schemas";
import { answerKeyFor, defaultPersonFields } from "@/lib/person-fields";

const ROLE = defaultPersonFields().role;
const parse = (written: string | null | undefined) => answerKeyFor(ROLE, written);

describe("answerKeyFor on today's Role answers", () => {
  it("accepts every stored key", () => {
    for (const role of ATTENDEE_ROLE_ORDER) {
      expect(parse(role)).toBe(role);
    }
  });

  it("accepts the human labels operators actually type", () => {
    expect(parse("Physician")).toBe("PHYSICIAN");
    expect(parse("Allied Health")).toBe("ALLIED_HEALTH");
    expect(parse("allied-health")).toBe("ALLIED_HEALTH");
    expect(parse("Medical Devices")).toBe("MEDICAL_DEVICES");
  });

  it("reads the label the contacts feed sends, which the old parser dropped", () => {
    expect(parse("Others (Spouse)")).toBe("OTHERS");
    expect(parse("Others")).toBe("OTHERS");
  });

  it("tolerates surrounding whitespace from spreadsheet cells", () => {
    expect(parse("  Physician  ")).toBe("PHYSICIAN");
  });

  it("returns null for empty / missing cells", () => {
    expect(parse("")).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse(undefined)).toBeNull();
    expect(parse("   ")).toBeNull();
    expect(parse("---")).toBeNull();
  });

  // A typo must not fail the whole row: role is optional.
  it("returns null for an unrecognized value rather than throwing", () => {
    expect(parse("Doctor")).toBeNull();
    expect(parse("PHYSICIAN_X")).toBeNull();
  });
});

describe("answerKeyFor on an organisation's own answers", () => {
  const own = {
    options: [
      { key: "ENG", label: "Software engineer", retired: false },
      { key: "PM", label: "Product manager", retired: true },
      { key: "Ärztin", label: "Ärztin", retired: false },
    ],
  };
  it("reads its keys and labels, retired ones included, and letters beyond English", () => {
    expect(answerKeyFor(own, "software-engineer")).toBe("ENG");
    expect(answerKeyFor(own, "PM")).toBe("PM");
    expect(answerKeyFor(own, "product manager")).toBe("PM");
    expect(answerKeyFor(own, "ärztin")).toBe("Ärztin");
  });
  it("never reads another organisation's answers", () => {
    expect(answerKeyFor(own, "Physician")).toBeNull();
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
    const src = readFileSync("src/components/contacts/import-contacts-csv.tsx", "utf8");
    const header = /"(title,firstName[^"]*)"/.exec(src);
    expect(header, "contacts template header not found").toBeTruthy();
    const cols = header![1].split(",");
    expect(cols.slice(0, 5)).toEqual(["title", "firstName", "lastName", "email", "phone"]);
    expect(cols).toContain("role");
  });
});
