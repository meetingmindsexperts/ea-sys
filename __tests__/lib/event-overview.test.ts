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
  offerLabel,
  publicRegistration,
  readAccreditations,
  type OverviewFacts,
  type PublicTicketType,
} from "@/lib/event-overview";

const NOW = new Date("2026-11-04T08:00:00Z");
const D = (n: number) => new Prisma.Decimal(n);
const tier = (name: string, price: number, over: Partial<PublicTicketType["pricingTiers"][number]> = {}) => ({
  name, sortOrder: null, price: D(price), currency: "USD", quantity: 999999, soldCount: 0, salesStart: null, salesEnd: null, ...over,
});
const type = (tiers: PublicTicketType["pricingTiers"], over: Partial<PublicTicketType> = {}): PublicTicketType => ({
  quantity: 999999, soldCount: 0, pricingTiers: tiers, ...over,
});
const reg = (ticketTypes: PublicTicketType[], over: Partial<Parameters<typeof publicRegistration>[0]> = {}) =>
  publicRegistration({ endDate: new Date("2027-01-17"), registrationOpen: true, eventFull: false, eventType: "CONFERENCE", settings: {}, ticketTypes, ...over }, NOW);

describe("publicRegistration (the register page's own rule)", () => {
  it("open at the rate the main link lands on, priced at its lowest paid price across types", () => {
    const r = reg([type([tier("Early Bird", 300, { salesEnd: new Date("2026-10-01") }), tier("Standard", 450)]), type([tier("Standard", 200)]), type([tier("Standard", 0)])]);
    expect(r.state).toBe("open");
    expect(r.offer).toEqual({ price: 200, currency: "USD", onSale: true, soldOut: false });
    expect(offerLabel(r.offer!)).toMatch(/^From \$200\.00$/);
  });

  it("REVIEW 1: the event-wide cap closes it as full, except on a hybrid event", () => {
    expect(reg([type([tier("Standard", 200)])], { eventFull: true }).state).toBe("sold-out");
    // Virtual attendance stays open at its own price: no in-person price quoted.
    expect(reg([type([tier("Standard", 200)])], { eventFull: true, eventType: "HYBRID" })).toEqual({ state: "open", offer: null });
  });

  it("REVIEW 2: a sponsor-code-only rate is never a reason to say Register", () => {
    const tiers = [tier("Standard", 450, { quantity: 1, soldCount: 1 }), tier("Inclusive", 0)];
    expect(reg([type(tiers)], { settings: { mainRegisterTiers: ["standard", "inclusive"], codeRequiredTiers: ["inclusive"] } }).state).toBe("sold-out");
  });

  it("an unticked rate is not a landing, so only it being open is closed", () => {
    expect(reg([type([tier("Complimentary", 0)])]).state).toBe("closed");
  });

  it("REVIEW 4: early bird over and standard full reads Fully booked, not Closed", () => {
    const r = reg([type([tier("Early Bird", 300, { salesEnd: new Date("2026-10-01") }), tier("Standard", 450, { quantity: 5, soldCount: 5 })])]);
    expect(r.state).toBe("sold-out");
    expect(r.offer?.price).toBe(450);
  });

  it("switched off, or before any window opens, is closed with no price", () => {
    expect(reg([type([tier("Standard", 200)])], { registrationOpen: false })).toEqual({ state: "closed", offer: null });
    expect(reg([type([tier("Standard", 200, { salesStart: new Date("2026-12-01") })])])).toEqual({ state: "closed", offer: null });
  });

  it("over is over", () => {
    expect(reg([type([tier("Standard", 200)])], { endDate: new Date("2026-10-01") })).toEqual({ state: "ended", offer: null });
  });

  it("a free event at every price reads Free", () => {
    expect(offerLabel(reg([type([tier("Standard", 0)])]).offer!)).toBe("Free");
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
