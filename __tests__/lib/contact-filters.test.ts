/**
 * The Contacts page filters, shared by the list and the export (Oct 23, 2026).
 */
import { DEFAULT_PUBLIC_PERSON_FIELDS, defaultPersonFields, storedAnswerLabel } from "@/lib/person-fields";
import { describe, it, expect } from "vitest";
import {
  MAX_VALUES_PER_FIELD,
  NOT_SET,
  contactExportFileName,
  contactFiltersAudit,
  contactFiltersQuery,
  contactFiltersWhere,
  groupFilterValues,
  hasContactFilters,
  parseContactFilters,
  toSearchParams,
} from "@/lib/contact-filters";
import { describeContactFilters } from "@/components/contacts/contact-field-filters";

const ROLE_FIELD = defaultPersonFields().role;
const parse = (q: string) => parseContactFilters(new URLSearchParams(q), ROLE_FIELD);

describe("parseContactFilters", () => {
  it("takes Role as a STORED value: exact, or a key in another case; never a loose label match (review of 2418a41f)", () => {
    const own = { options: [...ROLE_FIELD.options, { key: "DOC", label: "Physician", retired: false }, { key: "OLD", label: "Old job", retired: true }] };
    const role = (q: string) => {
      const r = parseContactFilters(new URLSearchParams(q), own);
      return r.ok ? r.filters.role : `refused: ${r.field}`;
    };
    expect(role("role=DOC")).toBe("DOC");
    expect(role("role=doc")).toBe("DOC");
    expect(role("role=OLD")).toBe("OLD");
    // A stored value no longer on the list is still filtered by, as stored.
    expect(role("role=PHYSICIAN")).toBe("PHYSICIAN");
    // Never swapped for another answer whose LABEL reads the same.
    expect(role("role=Physician")).toBe("PHYSICIAN");
    expect(role("role=Astronaut")).toBe("Astronaut");
    expect(role("role=__none__")).toBe(NOT_SET);
    expect(role(`role=${"x".repeat(101)}`)).toBe("refused: role");
  });


  it("reads every filter and trims it", () => {
    const r = parse("search= amina &tags=vip, kol&specialty=Cardiology&country=India&role=physician");
    expect(r).toEqual({
      ok: true,
      filters: { search: "amina", tags: ["vip", "kol"], specialty: ["Cardiology"], country: ["India"], role: "PHYSICIAN" },
    });
  });

  it("reads several specialties and countries as repeated parameters, commas kept", () => {
    const r = parse("specialty=Others, please specify&specialty=Cardiology&country=UAE&country= UAE &country=India");
    expect(r.ok && r.filters.specialty).toEqual(["Others, please specify", "Cardiology"]);
    expect(r.ok && r.filters.country).toEqual(["UAE", "India"]);
  });

  it("no params means no filters", () => {
    const r = parse("");
    expect(r.ok && hasContactFilters(r.filters)).toBe(false);
  });

  it("accepts the Not set choice for role", () => {
    const r = parse(`role=${NOT_SET}`);
    expect(r.ok && r.filters.role).toBe(NOT_SET);
  });

  it("refuses more than MAX_VALUES_PER_FIELD values for one field", () => {
    const many = Array.from({ length: MAX_VALUES_PER_FIELD + 1 }, (_, i) => `country=c${i}`).join("&");
    const r = parse(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("country");
    expect(parse(Array.from({ length: MAX_VALUES_PER_FIELD }, (_, i) => `country=c${i}`).join("&")).ok).toBe(true);
  });

  it("never returns the whole book for an unknown role: it filters by it, so it matches no one", () => {
    const r = parse("role=astronaut");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters.role).toBe("astronaut");
    expect(contactFiltersWhere("org1", r.filters).AND).toEqual([{ role: "astronaut" }]);
  });
});

describe("contactFiltersWhere", () => {
  const base = { search: "", tags: [], specialty: [] as string[], country: [] as string[], role: null };

  it("no filters is the organisation only", () => {
    expect(contactFiltersWhere("org1", base)).toEqual({ organizationId: "org1" });
  });

  it("specialty and country match whole values ignoring case", () => {
    expect(contactFiltersWhere("org1", { ...base, specialty: ["cardiology"], country: ["UNITED ARAB EMIRATES"] })).toEqual({
      organizationId: "org1",
      AND: [
        { OR: [{ specialty: { equals: "cardiology", mode: "insensitive" } }] },
        { OR: [{ country: { equals: "UNITED ARAB EMIRATES", mode: "insensitive" } }] },
      ],
    });
  });

  it("several values of one field match any of them; fields still combine with AND", () => {
    const w = contactFiltersWhere("org1", { ...base, country: ["UAE", "United Arab Emirates", NOT_SET], role: "PHYSICIAN" });
    expect(w.AND).toEqual([
      { role: "PHYSICIAN" },
      {
        OR: [
          { country: { equals: "UAE", mode: "insensitive" } },
          { country: { equals: "United Arab Emirates", mode: "insensitive" } },
          { country: null },
          { country: "" },
        ],
      },
    ]);
  });

  it("Not set matches null or empty, Role included now that it is text", () => {
    const w = contactFiltersWhere("org1", { ...base, country: [NOT_SET], role: NOT_SET });
    expect(w.AND).toEqual([{ OR: [{ role: null }, { role: "" }] }, { OR: [{ country: null }, { country: "" }] }]);
  });

  it("keeps the organisation on every shape", () => {
    const w = contactFiltersWhere("org1", { ...base, search: "x", tags: ["vip"], role: "PHYSICIAN" });
    expect(w.organizationId).toBe("org1");
    expect(w.AND).toHaveLength(3);
  });
});

describe("query and audit helpers", () => {
  it("contactFiltersQuery round-trips through the parser", () => {
    const q = contactFiltersQuery({ search: "a", tags: ["vip"], specialty: ["Cardiology", "Others, please specify"], country: [], role: "PHYSICIAN" });
    expect(q).toEqual({ search: "a", tags: "vip", specialty: ["Cardiology", "Others, please specify"], role: "PHYSICIAN" });
    const r = parseContactFilters(toSearchParams(q), ROLE_FIELD);
    expect(r.ok && r.filters.specialty).toEqual(["Cardiology", "Others, please specify"]);
  });

  it("the audit form never carries the search text", () => {
    const a = contactFiltersAudit({ search: "amina@x.com", tags: [], specialty: ["Cardiology"], country: [], role: null });
    expect(a).toEqual({ specialty: ["Cardiology"] });
  });
});

describe("wildcards and the Not recorded sentinel", () => {
  const base = { search: "", tags: [], specialty: [] as string[], country: [] as string[], role: null };

  it("escapes % and _ so a value only matches itself (insensitive equals is ILIKE)", () => {
    const w = contactFiltersWhere("org1", { ...base, specialty: ["%"], country: ["a_b\\c"] });
    expect(w.AND).toEqual([
      { OR: [{ specialty: { equals: "\\%", mode: "insensitive" } }] },
      { OR: [{ country: { equals: "a\\_b\\\\c", mode: "insensitive" } }] },
    ]);
  });

  it("a real value of 'none' is a value, not the blank choice", () => {
    const w = contactFiltersWhere("org1", { ...base, specialty: ["none"] });
    expect(w.AND).toEqual([{ OR: [{ specialty: { equals: "none", mode: "insensitive" } }] }]);
  });
});

describe("groupFilterValues", () => {
  it("merges case variants under the most common spelling and totals them", () => {
    const { options, notSet } = groupFilterValues([
      { value: "United Arab Emirates", count: 100 },
      { value: "UNITED ARAB EMIRATES", count: 7 },
      { value: "India", count: 50 },
      { value: null, count: 9 },
      { value: "", count: 1 },
      { value: "   ", count: 2 },
    ]);
    expect(options).toEqual([
      { value: "United Arab Emirates", count: 107 },
      { value: "India", count: 50 },
    ]);
    expect(notSet).toBe(12);
  });

  it("orders ties by name", () => {
    const { options } = groupFilterValues([{ value: "B", count: 3 }, { value: "A", count: 3 }]);
    expect(options.map((o) => o.value)).toEqual(["A", "B"]);
  });
});

describe("export file name and filter wording", () => {
  const day = new Date("2026-10-23T09:00:00Z");

  it("names the file after the filters, never the search text", () => {
    expect(contactExportFileName({ country: "India", specialty: "Cardiology", search: "amina" }, day)).toBe(
      "contacts-india-cardiology-search-2026-10-23.csv",
    );
    expect(contactExportFileName({ role: NOT_SET }, day)).toBe("contacts-not-recorded-2026-10-23.csv");
    expect(contactExportFileName({ country: ["UAE", "United Arab Emirates"] }, day)).toBe(
      "contacts-uae-united-arab-emirates-2026-10-23.csv",
    );
    expect(contactExportFileName({}, day)).toBe("contacts-all-2026-10-23.csv");
  });

  it("describes the filters in words for the export dialog", () => {
    expect(
      describeContactFilters(
        { search: "amina", tags: "vip,kol", country: ["India", "UAE"], role: "ALLIED_HEALTH", specialty: [NOT_SET] },
        (v) => storedAnswerLabel(DEFAULT_PUBLIC_PERSON_FIELDS.role, v),
      ),
    ).toEqual([
      "Search: “amina”",
      "Tags: vip, kol",
      "Specialty: Not recorded",
      "Country: India or UAE",
      "Role: Allied Health",
    ]);
  });
});
