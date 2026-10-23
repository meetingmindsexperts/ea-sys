/**
 * The Contacts page filters, shared by the list and the export (Oct 23, 2026).
 */
import { describe, it, expect } from "vitest";
import {
  NOT_SET,
  contactFiltersAudit,
  contactFiltersQuery,
  contactFiltersWhere,
  hasContactFilters,
  parseContactFilters,
} from "@/lib/contact-filters";

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
