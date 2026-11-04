/**
 * What search engines and AI assistants read (src/lib/seo.ts): the origin per
 * host, safe JSON-LD, schema.org Event, the robots rules and llms.txt.
 */
import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { ROBOTS_DISALLOW, absoluteUrl, catalogueJsonLd, eventJsonLd, jsonLdText, llmsText, siteOrigin, type LlmsEvent } from "@/lib/seo";

const event: LlmsEvent = {
  slug: "MEHF2027",
  name: "Middle East Heart Failure Conference 2027",
  startDate: new Date("2027-01-15T05:00:00Z"),
  endDate: new Date("2027-01-17T14:00:00Z"),
  timezone: "Asia/Dubai",
  venue: "Raffles Hotel",
  city: "Dubai",
  country: "United Arab Emirates",
  eventType: "CONFERENCE",
  specialty: "Cardiology",
  bannerImage: "/uploads/media/2026/10/banner.png",
  cmeHours: new Prisma.Decimal(8),
};
const ORIGIN = "https://events.meetingmindsgroup.com";

describe("siteOrigin", () => {
  it("is the request's host over https, http only on a local machine", () => {
    expect(siteOrigin("events.meetingmindsgroup.com")).toBe(ORIGIN);
    expect(siteOrigin("tenant.example.org", "https")).toBe("https://tenant.example.org");
    expect(siteOrigin("localhost:3113")).toBe("http://localhost:3113");
  });

  it("a missing or malformed host falls back to the configured address", () => {
    expect(siteOrigin(null)).toMatch(/^https?:\/\//);
    expect(siteOrigin("evil.com/<script>")).not.toContain("evil");
  });
});

describe("structured data", () => {
  it("cannot close its script tag early", () => {
    expect(jsonLdText({ name: "</script><script>alert(1)</script>" })).not.toContain("</script>");
  });

  it("an event carries what Google and assistants read: dates, place, mode, image, organiser", () => {
    const ld = eventJsonLd(event, ORIGIN, { name: "MM Group" });
    expect(ld).toMatchObject({
      "@type": "Event",
      url: `${ORIGIN}/e/MEHF2027`,
      startDate: "2027-01-15T05:00:00.000Z",
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      location: { "@type": "Place", name: "Raffles Hotel", address: { addressLocality: "Dubai", addressCountry: "United Arab Emirates" } },
      image: [`${ORIGIN}/uploads/media/2026/10/banner.png`],
      organizer: { "@type": "Organization", name: "MM Group", url: ORIGIN },
    });
    expect(ld.description).toBe("Middle East Heart Failure Conference 2027 is a Cardiology conference in Dubai, United Arab Emirates, carrying 8 CME hours.");
  });

  it("a webinar's summary says online, not the organiser's city", () => {
    expect(eventJsonLd({ ...event, eventType: "WEBINAR" }, ORIGIN, null).description).toBe(
      "Middle East Heart Failure Conference 2027 is an online Cardiology webinar, carrying 8 CME hours.",
    );
  });

  it("a webinar is online, at its own page", () => {
    const ld = eventJsonLd({ ...event, eventType: "WEBINAR" }, ORIGIN, null);
    expect(ld.location).toEqual({ "@type": "VirtualLocation", url: `${ORIGIN}/e/MEHF2027` });
    expect(ld).not.toHaveProperty("organizer");
  });

  it("the catalogue lists its events in order, with the organisation and a breadcrumb", () => {
    const ld = catalogueJsonLd([event], ORIGIN, { name: "MM Group", logo: "/uploads/logo.png" });
    const types = ld["@graph"].map((n) => n["@type"]);
    expect(types).toEqual(["Organization", "BreadcrumbList", "ItemList"]);
    expect(JSON.stringify(ld)).toContain(`"logo":"${ORIGIN}/uploads/logo.png"`);
  });

  it("a topic page names its list and adds itself to the breadcrumb", () => {
    const ld = catalogueJsonLd([event], ORIGIN, null, { name: "Cardiology conferences and CME events", path: "/catalogue/specialty/cardiology" });
    const [crumbs, list] = ld["@graph"] as { "@type": string; itemListElement: { item?: unknown; name?: string }[]; name?: string; url?: string }[];
    expect(crumbs.itemListElement.map((i) => i.item)).toEqual([`${ORIGIN}/catalogue`, `${ORIGIN}/catalogue/specialty/cardiology`]);
    expect(list).toMatchObject({ name: "Cardiology conferences and CME events", url: `${ORIGIN}/catalogue/specialty/cardiology` });
  });

  it("llms.txt lists the topic pages", () => {
    const text = llmsText({ origin: ORIGIN, organizationName: "MM Group", events: [], formatDates: () => "", topics: [["Medical conferences and CME events in Oman", "/catalogue/country/oman"]] });
    expect(text).toContain(`## Browse by specialty and country\n\n- [Medical conferences and CME events in Oman](${ORIGIN}/catalogue/country/oman)`);
  });

  it("absoluteUrl leaves a full URL alone", () => {
    expect(absoluteUrl(ORIGIN, "https://cdn.example/x.png")).toBe("https://cdn.example/x.png");
  });
});

describe("robots rules", () => {
  it("keep personal, sign-in, secret-link and staff pages out", () => {
    for (const p of ["/api/", "/dashboard", "/events", "/my-registration", "/login", "/e/*/shared/", "/e/*/survey", "/e/*/my-registration"]) {
      expect(ROBOTS_DISALLOW).toContain(p);
    }
  });

  it("never block the public catalogue, an event's page and form, or the images they show", () => {
    for (const p of ROBOTS_DISALLOW) {
      const open = ["/catalogue", "/e/MEHF2027", "/e/MEHF2027/register", "/e/MEHF2027/agenda", "/uploads/media/2026/10/banner.png"];
      expect(open.some((url) => url.startsWith(p.replace("/*", "/MEHF2027")))).toBe(false);
    }
  });
});

describe("llms.txt", () => {
  it("names the organisation, the catalogue and each upcoming event with its facts", () => {
    const text = llmsText({ origin: ORIGIN, organizationName: "MM Group", events: [event], formatDates: () => "January 15 – 17, 2027" });
    expect(text).toMatch(/^# MM Group events\n/);
    expect(text).toContain(`[Event catalogue](${ORIGIN}/catalogue)`);
    expect(text).toContain(
      `- [Middle East Heart Failure Conference 2027](${ORIGIN}/e/MEHF2027): January 15 – 17, 2027 · Raffles Hotel, Dubai, United Arab Emirates · Conference · Cardiology · 8 CME hours`,
    );
  });

  it("stays neutral when the site resolves no organisation", () => {
    const text = llmsText({ origin: ORIGIN, organizationName: null, events: [], formatDates: () => "" });
    expect(text).toMatch(/^# Medical events\n/);
    expect(text).toContain("> Medical conferences, workshops and webinars. Each event");
  });

  it("says so when nothing is listed", () => {
    expect(llmsText({ origin: ORIGIN, organizationName: "MM Group", events: [], formatDates: () => "" })).toContain("No upcoming events are listed right now.");
  });
});
