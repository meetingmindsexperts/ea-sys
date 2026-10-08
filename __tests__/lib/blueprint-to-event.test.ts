/** What an approved blueprint becomes: the event, its first-day sessions, its sponsors (owner rulings, Oct 8, 2026). */
import { describe, it, expect } from "vitest";
import { daysFrom, planEventFromBlueprint } from "@/lib/blueprint/blueprint-to-event";

const DUBAI = "Asia/Dubai";
const exact = { y: 2027, m: 3, d: 4, approx: false, yearOnly: false };
const brief = {
  format: "Hybrid",
  basics: { title: "Heart Summit", purpose: "Align the region", duration: "2 days", location: "Dubai" },
  look: { venueName: "Conrad Dubai" },
  programme: {
    rows: [
      { time: "09:00", title: "Opening", space: "Main hall", who: "Chair" },
      { time: "10:30", title: "Coffee", space: "Foyer", who: "" },
      { time: "", title: "Gala dinner", space: "", who: "" },
      { time: "17:00", title: "Close", space: "Main hall", who: "" },
    ],
  },
  people: { hosts: [{ name: "Dr A" }, { name: "" }] },
  partners: { has: "yes", list: [{ name: "Acme Pharma", tier: "Gold" }, { name: "" }] },
};

describe("planEventFromBlueprint", () => {
  it("refuses a vague date rather than inventing one", () => {
    for (const when of [{ ...exact, approx: true }, { ...exact, yearOnly: true }, { invalid: true as const }]) {
      expect(planEventFromBlueprint(brief, when, DUBAI)).toMatchObject({ ok: false, code: "DATES_NEEDED" });
    }
  });

  it("builds the event over the right days in Dubai time", () => {
    const res = planEventFromBlueprint(brief, exact, DUBAI);
    if (!res.ok) throw new Error("expected a plan");
    expect(res.plan.event).toMatchObject({ name: "Heart Summit", eventType: "HYBRID", venue: "Conrad Dubai", description: "Align the region" });
    expect(res.plan.event.startDate.toISOString()).toBe("2027-03-03T20:00:00.000Z");
    expect(res.plan.event.endDate.toISOString()).toBe("2027-03-05T19:59:00.000Z");
  });

  it("turns timed programme rows into first-day sessions, each ending when the next starts", () => {
    const res = planEventFromBlueprint(brief, exact, DUBAI);
    if (!res.ok) throw new Error("expected a plan");
    expect(res.plan.sessions.map((s) => [s.name, s.startTime.toISOString(), s.endTime.toISOString(), s.location])).toEqual([
      ["Opening", "2027-03-04T05:00:00.000Z", "2027-03-04T06:30:00.000Z", "Main hall"],
      ["Coffee", "2027-03-04T06:30:00.000Z", "2027-03-04T13:00:00.000Z", "Foyer"],
      ["Close", "2027-03-04T13:00:00.000Z", "2027-03-04T14:00:00.000Z", "Main hall"],
    ]);
    expect(res.plan.sessions[0].description).toBe("With: Chair");
    expect(res.plan.skipped).toContain('Programme item "Gala dinner": no time like 09:00, so not added to the agenda');
  });

  it("adds named partners as sponsors, and keeps named people in the brief", () => {
    const res = planEventFromBlueprint(brief, exact, DUBAI);
    if (!res.ok) throw new Error("expected a plan");
    expect(res.plan.sponsors).toEqual([{ name: "Acme Pharma", tier: "gold" }]);
    expect(res.plan.skipped[0]).toBe("1 named person: no email address in the brief, so not added as speakers");
  });

  it.each([
    ["In person", "CONFERENCE"],
    ["Hybrid", "HYBRID"],
    ["Virtual", "WEBINAR"],
    ["Online world only", "CONFERENCE"],
  ])("format %s becomes %s", (format, type) => {
    const res = planEventFromBlueprint({ ...brief, format }, exact, DUBAI);
    expect(res.ok && res.plan.event.eventType).toBe(type);
  });
});

describe("partner tiers", () => {
  it.each([
    ["Title", "platinum"],
    ["Gold", "gold"],
    ["Media", "partner"],
    ["Supporter", "partner"],
    ["Diamond", null],
  ])("%s becomes %s", (tier, expected) => {
    const res = planEventFromBlueprint({ ...brief, partners: { has: "yes", list: [{ name: "X", tier }] } }, exact, DUBAI);
    expect(res.ok && res.plan.sponsors[0].tier).toBe(expected);
  });
});

describe("daysFrom", () => {
  it.each([
    ["2 days", 2],
    ["a two-day congress", 2],
    ["3-day", 3],
    ["one evening", 1],
    ["", 1],
    ["40 days", 14],
  ])("%s -> %i", (text, days) => {
    expect(daysFrom(text)).toBe(days);
  });
});
