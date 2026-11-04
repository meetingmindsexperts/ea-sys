/**
 * The public catalogue's rules (src/lib/catalogue.ts): only switched-on,
 * public-status events, the filters read safely from the URL, and links that
 * keep or reset the right parts.
 */
import { describe, it, expect } from "vitest";
import { catalogueBaseWhere, catalogueHref, catalogueOrderBy, catalogueWhere, parseCatalogueQuery } from "@/lib/catalogue";

const NOW = new Date("2026-11-04T10:00:00Z");
const ORG = { organizationId: "org1" };

describe("which events the catalogue lists", () => {
  it("only this organisation's, only those switched on, never a draft or cancelled one", () => {
    expect(catalogueBaseWhere(ORG)).toEqual({
      organizationId: "org1",
      status: { in: ["PUBLISHED", "LIVE", "COMPLETED"] },
      settings: { path: ["showInCatalogue"], equals: true },
    });
  });

  it("upcoming: published or live and not yet over; past: over", () => {
    const up = catalogueWhere(ORG, parseCatalogueQuery({}), NOW);
    expect(up.AND).toEqual([{ status: { in: ["PUBLISHED", "LIVE"] }, endDate: { gte: NOW } }]);
    const past = catalogueWhere(ORG, parseCatalogueQuery({ when: "past" }), NOW);
    expect(past.AND).toEqual([{ endDate: { lt: NOW } }]);
  });

  it("an unknown host's sentinel scope is kept, so it lists nothing", () => {
    expect(catalogueWhere({ organizationId: "__tenant_unresolved__" }, parseCatalogueQuery({}), NOW).organizationId).toBe("__tenant_unresolved__");
  });

  it("search and filters narrow with AND", () => {
    const where = catalogueWhere(ORG, parseCatalogueQuery({ q: "heart", country: "Oman", type: "webinar", specialty: "Cardiology" }), NOW);
    const and = where.AND as unknown[];
    expect(and).toContainEqual({ country: "Oman" });
    expect(and).toContainEqual({ eventType: "WEBINAR" });
    expect(and).toContainEqual({ specialty: "Cardiology" });
    expect(JSON.stringify(and)).toContain('"contains":"heart","mode":"insensitive"');
  });
});

describe("reading the URL", () => {
  it("anything unrecognised is no filter, not an error", () => {
    expect(parseCatalogueQuery({ type: "PARTY", when: "soon", page: "-3" })).toEqual({ q: "", country: "", type: null, specialty: "", when: "upcoming", page: 1 });
    expect(parseCatalogueQuery({ page: "abc" }).page).toBe(1);
    expect(parseCatalogueQuery({ page: "99999" }).page).toBe(1000);
  });

  it("a long search is cut, and repeated params take the first", () => {
    expect(parseCatalogueQuery({ q: "x".repeat(500) }).q).toHaveLength(100);
    expect(parseCatalogueQuery({ country: ["Oman", "Qatar"] }).country).toBe("Oman");
  });
});

describe("order and links", () => {
  it("soonest first while upcoming, most recent first once past", () => {
    expect(catalogueOrderBy(parseCatalogueQuery({}))[0]).toEqual({ startDate: "asc" });
    expect(catalogueOrderBy(parseCatalogueQuery({ when: "past" }))[0]).toEqual({ startDate: "desc" });
  });

  it("changing a filter or tab resets the page; changing the page keeps the filters", () => {
    const q = parseCatalogueQuery({ q: "heart", country: "Oman", page: "3" });
    expect(catalogueHref(q, { when: "past" })).toBe("/catalogue?q=heart&country=Oman&when=past");
    expect(catalogueHref(q, { page: 4 })).toBe("/catalogue?q=heart&country=Oman&page=4");
    expect(catalogueHref(parseCatalogueQuery({}), {})).toBe("/catalogue");
  });
});
