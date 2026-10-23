/**
 * The Contacts page filters, shared by the list and the export (Oct 23, 2026).
 */
import { describe, it, expect } from "vitest";
import {
  NOT_SET,
  contactExportFileName,
  contactFiltersAudit,
  contactFiltersQuery,
  contactFiltersWhere,
  groupFilterValues,
  hasContactFilters,
  parseContactFilters,
} from "@/lib/contact-filters";
import { describeContactFilters } from "@/components/contacts/contact-field-filters";

const parse = (q: string) => parseContactFilters(new URLSearchParams(q));

describe("parseContactFilters", () => {
  it("reads every filter and trims it", () => {
    const r = parse("search= amina &tags=vip, kol&specialty=Cardiology&country=India&role=physician");
    expect(r).toEqual({
      ok: true,
      filters: { search: "amina", tags: ["vip", "kol"], specialty: "Cardiology", country: "India", role: "PHYSICIAN" },
    });
  });

  it("no params means no filters", () => {
    const r = parse("");
    expect(r.ok && hasContactFilters(r.filters)).toBe(false);
  });

  it("accepts the Not set choice for role", () => {
    const r = parse(`role=${NOT_SET}`);
    expect(r.ok && r.filters.role).toBe(NOT_SET);
  });

  it("refuses an unknown role instead of returning the whole book", () => {
    const r = parse("role=astronaut");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("role");
  });
});

describe("contactFiltersWhere", () => {
  const base = { search: "", tags: [], specialty: null, country: null, role: null };

  it("no filters is the organisation only", () => {
    expect(contactFiltersWhere("org1", base)).toEqual({ organizationId: "org1" });
  });

  it("specialty and country match whole values ignoring case", () => {
    expect(contactFiltersWhere("org1", { ...base, specialty: "cardiology", country: "UNITED ARAB EMIRATES" })).toEqual({
      organizationId: "org1",
      AND: [
        { specialty: { equals: "cardiology", mode: "insensitive" } },
        { country: { equals: "UNITED ARAB EMIRATES", mode: "insensitive" } },
      ],
    });
  });

  it("Not set matches null or empty, for role null only", () => {
    const w = contactFiltersWhere("org1", { ...base, country: NOT_SET, role: NOT_SET });
    expect(w.AND).toEqual([{ role: null }, { OR: [{ country: null }, { country: "" }] }]);
  });

  it("keeps the organisation on every shape", () => {
    const w = contactFiltersWhere("org1", { ...base, search: "x", tags: ["vip"], role: "PHYSICIAN" });
    expect(w.organizationId).toBe("org1");
    expect(w.AND).toHaveLength(3);
  });
});

describe("query and audit helpers", () => {
  it("contactFiltersQuery round-trips through the parser", () => {
    const q = contactFiltersQuery({ search: "a", tags: ["vip"], specialty: "Cardiology", country: null, role: "PHYSICIAN" });
    expect(q).toEqual({ search: "a", tags: "vip", specialty: "Cardiology", role: "PHYSICIAN" });
    const r = parseContactFilters(new URLSearchParams(q));
    expect(r.ok && r.filters.specialty).toBe("Cardiology");
  });

  it("the audit form never carries the search text", () => {
    const a = contactFiltersAudit({ search: "amina@x.com", tags: [], specialty: "Cardiology", country: null, role: null });
    expect(a).toEqual({ specialty: "Cardiology" });
  });
});

describe("wildcards and the Not recorded sentinel", () => {
  const base = { search: "", tags: [], specialty: null, country: null, role: null };

  it("escapes % and _ so a value only matches itself (insensitive equals is ILIKE)", () => {
    const w = contactFiltersWhere("org1", { ...base, specialty: "%", country: "a_b\\c" });
    expect(w.AND).toEqual([
      { specialty: { equals: "\\%", mode: "insensitive" } },
      { country: { equals: "a\\_b\\\\c", mode: "insensitive" } },
    ]);
  });

  it("a real value of 'none' is a value, not the blank choice", () => {
    const w = contactFiltersWhere("org1", { ...base, specialty: "none" });
    expect(w.AND).toEqual([{ specialty: { equals: "none", mode: "insensitive" } }]);
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
    expect(contactExportFileName({}, day)).toBe("contacts-all-2026-10-23.csv");
  });

  it("describes the filters in words for the export dialog", () => {
    expect(describeContactFilters({ search: "amina", tags: "vip,kol", country: "India", role: "ALLIED_HEALTH", specialty: NOT_SET })).toEqual([
      "Search: “amina”",
      "Tags: vip, kol",
      "Specialty: Not recorded",
      "Country: India",
      "Role: Allied Health",
    ]);
  });
});
