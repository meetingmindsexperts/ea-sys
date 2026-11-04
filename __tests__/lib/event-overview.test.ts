/**
 * The public event page's rules (src/lib/event-overview.ts): the lowest
 * price on sale, the call to action, accreditor names, the questions the page
 * answers, and its structured data.
 */
import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  accreditorLabel,
  buildFaq,
  eventPageJsonLd,
  lowestPublicOffer,
  offerLabel,
  readAccreditations,
  registrationState,
  type OverviewFacts,
  type PublicTicketType,
} from "@/lib/event-overview";

const NOW = new Date("2026-11-04T08:00:00Z");
const D = (n: number) => new Prisma.Decimal(n);
const type = (over: Partial<PublicTicketType> = {}): PublicTicketType => ({
  price: D(500), currency: "AED", quantity: 999999, soldCount: 0, salesStart: null, salesEnd: null, pricingTiers: [], ...over,
});
const tier = (price: number, over: Partial<PublicTicketType["pricingTiers"][number]> = {}) => ({
  price: D(price), currency: "AED", quantity: 999999, soldCount: 0, salesStart: null, salesEnd: null, ...over,
});

describe("lowestPublicOffer", () => {
  it("the cheapest tier on sale now, not a cheaper one whose window has shut", () => {
    const offer = lowestPublicOffer([type({ pricingTiers: [tier(300, { salesEnd: new Date("2026-10-01") }), tier(450), tier(600)] })], NOW);
    expect(offer).toEqual({ price: 450, currency: "AED", onSale: true, soldOut: false });
    expect(offerLabel(offer!)).toMatch(/^From AED\s450\.00$/);
  });

  it("a type without tiers sells on its own window, and the type's seats cap its tiers", () => {
    expect(lowestPublicOffer([type({ price: D(750) })], NOW)?.price).toBe(750);
    const full = lowestPublicOffer([type({ quantity: 10, soldCount: 10, pricingTiers: [tier(200, { quantity: 50 })] })], NOW);
    expect(full).toMatchObject({ onSale: false, soldOut: true });
  });

  it("nothing on sale yet: still a price to quote, but not sold out", () => {
    const offer = lowestPublicOffer([type({ salesStart: new Date("2026-12-01") })], NOW);
    expect(offer).toEqual({ price: 500, currency: "AED", onSale: false, soldOut: false });
  });

  it("a free type does not make a paid event read Free", () => {
    const offer = lowestPublicOffer([type({ price: D(0) }), type({ pricingTiers: [tier(200), tier(350)] })], NOW);
    expect(offer).toMatchObject({ price: 200, onSale: true });
  });

  it("free reads Free; no types is no offer", () => {
    expect(offerLabel(lowestPublicOffer([type({ price: D(0) })], NOW)!)).toBe("Free");
    expect(lowestPublicOffer([], NOW)).toBeNull();
  });
});

describe("registrationState", () => {
  const offer = { price: 100, currency: "AED", onSale: true, soldOut: false };
  const future = new Date("2027-01-01");
  it("open, closed by the organiser, full, or over", () => {
    expect(registrationState({ endDate: future, registrationOpen: true, offer }, NOW)).toBe("open");
    expect(registrationState({ endDate: future, registrationOpen: false, offer }, NOW)).toBe("closed");
    expect(registrationState({ endDate: future, registrationOpen: true, offer: { ...offer, onSale: false, soldOut: true } }, NOW)).toBe("sold-out");
    expect(registrationState({ endDate: future, registrationOpen: true, offer: null }, NOW)).toBe("closed");
    expect(registrationState({ endDate: new Date("2026-10-01"), registrationOpen: true, offer }, NOW)).toBe("ended");
  });
});

describe("accreditors", () => {
  it("the typed name wins; a known body gets its full name; an unnamed OTHER is left out", () => {
    expect(accreditorLabel({ body: "OTHER", name: "Oman Medical Specialty Board (OMSB)" })).toBe("Oman Medical Specialty Board (OMSB)");
    expect(accreditorLabel({ body: "DHA" })).toBe("Dubai Health Authority (DHA)");
    expect(accreditorLabel({ body: "OTHER" })).toBeNull();
  });

  it("reads only well-formed entries from settings", () => {
    expect(readAccreditations({ cme: { accreditations: [{ body: "DHA", reference: "R1" }, null, { nope: 1 }] } })).toEqual([{ body: "DHA", reference: "R1" }]);
    expect(readAccreditations(null)).toEqual([]);
  });
});

const ORIGIN = "https://events.meetingmindsgroup.com";
const facts = (over: Partial<OverviewFacts> = {}): OverviewFacts => ({
  event: {
    slug: "BHS2026", name: "BHS 2026", startDate: new Date("2026-10-24T05:00:00Z"), endDate: new Date("2026-10-24T14:00:00Z"),
    timezone: "Asia/Dubai", venue: "DoubleTree", city: "Fujairah", country: "United Arab Emirates", eventType: "CONFERENCE",
    specialty: "Hematology", bannerImage: null, cmeHours: D(6),
  },
  dates: "October 24, 2026",
  accreditors: ["Dubai Health Authority (DHA)"],
  audiences: ["Physician", "Nurse"],
  offer: { price: 450, currency: "AED", onSale: true, soldOut: false },
  state: "open",
  origin: ORIGIN,
  ...over,
});

describe("buildFaq", () => {
  it("asks only what the event can answer, and each answer names the event", () => {
    const qs = buildFaq(facts()).map((q) => q.question);
    expect(qs).toEqual([
      "When and where is BHS 2026?",
      "How many CME hours does BHS 2026 carry?",
      "Who can attend BHS 2026?",
      "How much does it cost to register for BHS 2026?",
      "How do I register for BHS 2026?",
      "How do I get my CME certificate?",
    ]);
    expect(buildFaq(facts())[1].answer).toBe("BHS 2026 carries 6 CME hours, accredited by Dubai Health Authority (DHA). Certificates are issued after the event to registered attendees.");
  });

  it("no CME, no price, not open: those questions are not asked", () => {
    const qs = buildFaq(facts({ event: { ...facts().event, cmeHours: null }, offer: null, state: "ended", audiences: [] })).map((q) => q.question);
    expect(qs).toEqual(["When and where is BHS 2026?"]);
  });

  it("a webinar happens online", () => {
    expect(buildFaq(facts({ event: { ...facts().event, eventType: "WEBINAR" } }))[0].answer).toBe("BHS 2026 takes place October 24, 2026, online.");
  });
});

describe("eventPageJsonLd", () => {
  const ld = (over: Partial<OverviewFacts> = {}, listed = true) =>
    eventPageJsonLd({ ...facts(over), description: "About BHS.", organization: { name: "MM Group" }, speakers: [{ name: "Dr. A B", jobTitle: "Consultant", organization: "Dubai Hospital" }], listed });

  it("the Event carries its price, availability, faculty and description", () => {
    const event = ld()["@graph"][0] as Record<string, unknown>;
    expect(event).toMatchObject({
      "@type": "Event",
      description: "About BHS.",
      offers: { "@type": "Offer", price: "450.00", priceCurrency: "AED", url: `${ORIGIN}/e/BHS2026/register`, availability: "https://schema.org/InStock" },
      performer: [{ "@type": "Person", name: "Dr. A B", jobTitle: "Consultant", worksFor: { "@type": "Organization", name: "Dubai Hospital" } }],
    });
  });

  it("free is marked accessible for free; a closed event claims no availability", () => {
    const free = ld({ offer: { price: 0, currency: "AED", onSale: true, soldOut: false } })["@graph"][0] as Record<string, unknown>;
    expect(free.isAccessibleForFree).toBe(true);
    const closed = ld({ state: "closed" })["@graph"][0] as { offers: Record<string, unknown> };
    expect(closed.offers).not.toHaveProperty("availability");
  });

  it("the breadcrumb starts at the catalogue only when the event is listed, and the FAQ is there", () => {
    const listed = ld()["@graph"] as { "@type": string; itemListElement?: unknown[] }[];
    expect(listed.map((n) => n["@type"])).toEqual(["Event", "BreadcrumbList", "FAQPage"]);
    expect(listed[1].itemListElement).toHaveLength(2);
    expect((ld({}, false)["@graph"][1] as { itemListElement: unknown[] }).itemListElement).toHaveLength(1);
  });
});
