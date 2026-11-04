/**
 * The public catalogue's rules (src/lib/catalogue.ts): only switched-on,
 * public-status events, the filters read safely from the URL, and links that
 * keep or reset the right parts.
 */
import { describe, it, expect } from "vitest";
import { catalogueBaseWhere, catalogueHref, catalogueOrderBy, catalogueWhere, findTopic, groupTopics, parseCatalogueQuery, topicForValue, topicHref, topicIntro, topicSlug, topicTitle } from "@/lib/catalogue";

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

describe("topic pages", () => {
  it("slugs read like the words and survive accents, ampersands and punctuation", () => {
    expect(topicSlug("United Arab Emirates")).toBe("united-arab-emirates");
    expect(topicSlug("Côte d'Ivoire")).toBe("cote-d-ivoire");
    expect(topicSlug("Obstetrics & Gynaecology")).toBe("obstetrics-and-gynaecology");
    expect(topicSlug("  Cardiology ")).toBe("cardiology");
  });

  it("spellings group under one slug, labelled by the most common, with every raw value kept", () => {
    const topics = groupTopics([
      { value: "Cardiology", count: 3 },
      { value: "cardiology", count: 1 },
      { value: "Cardiology ", count: 1 },
      { value: "Hematology", count: 2 },
      { value: "—", count: 1 },
      { value: "  ", count: 1 },
      { value: null, count: 4 },
    ]);
    expect(topics).toEqual([
      { slug: "cardiology", label: "Cardiology", variants: ["Cardiology", "cardiology", "Cardiology "] },
      { slug: "hematology", label: "Hematology", variants: ["Hematology"] },
    ]);
    expect(findTopic(topics, "hematology")?.label).toBe("Hematology");
    expect(findTopic(topics, "oncology")).toBeNull();
    expect(topicForValue(topics, "cardiology ")?.variants).toHaveLength(3);
  });

  it("a filter with variants matches every stored spelling", () => {
    const where = catalogueWhere(ORG, parseCatalogueQuery({ specialty: "Cardiology" }), NOW, { specialty: ["Cardiology", "Cardiology "] });
    expect(where.AND as unknown[]).toContainEqual({ specialty: { in: ["Cardiology", "Cardiology "] } });
  });

  it("links carry only the tab and the page", () => {
    expect(topicHref("country", "Oman")).toBe("/catalogue/country/oman");
    expect(topicHref("specialty", "Cardiology", { when: "past", page: 2 })).toBe("/catalogue/specialty/cardiology?when=past&page=2");
  });

  it("headings are written the way people search", () => {
    expect(topicTitle("specialty", "Cardiology")).toBe("Cardiology conferences and CME events");
    expect(topicTitle("country", "Oman")).toBe("Medical conferences and CME events in Oman");
  });

  it("the intro counts upcoming events, names places or specialties, and the most CME hours", () => {
    const e = (city: string | null, country: string, specialty: string, cme: number | null) => ({ city, country, specialty, cmeHours: cme === null ? null : { toString: () => String(cme) } });
    expect(topicIntro("specialty", "Cardiology", [e("Dubai", "UAE", "Cardiology", 8), e("Fujairah", "UAE", "Cardiology", null), e("Dubai", "UAE", "Cardiology", 6)])).toBe(
      "3 upcoming Cardiology events in Dubai and Fujairah, carrying up to 8 CME hours.",
    );
    expect(topicIntro("country", "Oman", [e("Muscat", "Oman", "Hematology", null)])).toBe("1 upcoming medical event in Oman across Hematology.");
    expect(topicIntro("country", "Qatar", [])).toBe("There are no upcoming events in Qatar right now; past events are listed below.");
    // The count is the true total when the facts are a capped sample.
    expect(topicIntro("country", "Oman", [e("Muscat", "Oman", "Hematology", null)], 240)).toBe("240 upcoming medical events in Oman across Hematology.");
  });
});
