/**
 * My events journey (docs/MY_PORTAL_PLAN.md, phase 2): the steps one
 * registration shows, and which surveys it is asked. The money and "answered"
 * rules are the shared ones, so these pin the wiring, not new rules.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { buildJourney, paymentStep, surveyLinesFor, type EventSurveyRow } from "@/lib/registrant-journey";

const NOW = new Date("2026-11-09T10:00:00Z");

function reg(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    groupId: null,
    attendanceMode: "IN_PERSON",
    originalPrice: null,
    discountAmount: null,
    surveyCompletedAt: null,
    pricingTier: null,
    ticketType: { name: "Physician", price: 0 },
    ...over,
  } as unknown as Parameters<typeof buildJourney>[0]["registration"];
}

const labels = (steps: { label: string; state: string }[]) => steps.map((s) => `${s.label}:${s.state}`);

describe("paymentStep", () => {
  it("names each settled state and never shows an amount", () => {
    expect(paymentStep(reg({ paymentStatus: "PAID" })).label).toBe("Paid");
    expect(paymentStep(reg({ paymentStatus: "INCLUSIVE" })).label).toBe("Sponsored");
    expect(paymentStep(reg({ paymentStatus: "COMPLIMENTARY", ticketType: { price: 500 } })).label).toBe("Complimentary");
    expect(paymentStep(reg({ groupId: "g1", ticketType: { price: 500 } })).label).toBe("Group invoice");
  });

  it("reads an UNPAID row on a free rate as free, and on a priced rate as due", () => {
    expect(paymentStep(reg())).toEqual({ key: "payment", label: "Free", state: "done" });
    expect(paymentStep(reg({ ticketType: { price: 250 } }))).toEqual({ key: "payment", label: "Payment due", state: "action" });
  });

  it("uses the stamped price and the discount, as the event page does", () => {
    expect(paymentStep(reg({ originalPrice: 300, discountAmount: 300, ticketType: { price: 300 } })).label).toBe("Free");
    // A stamped 0 next to a priced tier owes the tier price (readRegistrationBasePrice's guard).
    expect(paymentStep(reg({ originalPrice: 0, pricingTier: { price: 120 } })).state).toBe("action");
  });
});

describe("buildJourney", () => {
  const past = { endDate: new Date("2026-10-31T18:00:00Z"), eventType: "CONFERENCE", status: "COMPLETED" };
  const upcoming = { endDate: new Date("2027-01-17T18:00:00Z"), eventType: "CONFERENCE", status: "PUBLISHED" };

  it("an upcoming conference: registered, paid, check in at the event, nothing about certificates", () => {
    expect(labels(buildJourney({ registration: reg({ paymentStatus: "PAID" }), event: upcoming, surveys: [], certificateCount: 0, now: NOW }))).toEqual([
      "Registered:done",
      "Paid:done",
      "Check in at the event:waiting",
    ]);
  });

  it("a past event with a survey to answer and a certificate", () => {
    const steps = buildJourney({
      registration: reg({ status: "CHECKED_IN" }),
      event: past,
      surveys: [{ id: "s1", name: "Post-event survey", answered: false, daily: false, open: true, certificate: true }],
      certificateCount: 2,
      now: NOW,
    });
    expect(labels(steps)).toEqual(["Registered:done", "Free:done", "Checked in:done", "Survey to answer:action", "2 certificates ready:done"]);
  });

  it("an unpaid fee is a to-do exactly while the checkout would take it: by the event's status, never its dates", () => {
    const owing = reg({ ticketType: { name: "Physician", price: 250 } });
    const journey = (event: typeof past) => labels(buildJourney({ registration: owing, event, surveys: [], certificateCount: 0, now: NOW }));
    expect(journey(upcoming)).toContain("Payment due:action");
    // Ended, but still published (nothing completes an event by itself): the checkout still works.
    expect(journey({ ...past, status: "PUBLISHED" })).toContain("Payment due:action");
    expect(journey({ ...past, status: "LIVE" })).toContain("Payment due:action");
    // Closed and over: a fact, and nothing waits for them.
    expect(journey(past)).toContain("Not paid:missed");
    expect(journey(past).some((step) => step.endsWith(":action"))).toBe(false);
    // Closed before it happened (cancelled, or back to draft): no Pay now that dead-ends.
    expect(journey({ ...upcoming, status: "CANCELLED" })).toContain("Payment not open:waiting");
    expect(journey({ ...upcoming, status: "DRAFT" })).toContain("Payment not open:waiting");
  });

  it("a settled or free registration reads the same after the event", () => {
    const journey = (over: Record<string, unknown>) => labels(buildJourney({ registration: reg(over), event: past, surveys: [], certificateCount: 0, now: NOW }));
    expect(journey({ paymentStatus: "PAID", ticketType: { name: "Physician", price: 250 } })).toContain("Paid:done");
    expect(journey({})).toContain("Free:done");
  });

  it("never says Not checked in beside a certificate: the desk does not scan everyone", () => {
    const journey = (certificateCount: number) => labels(buildJourney({ registration: reg({ paymentStatus: "PAID" }), event: past, surveys: [], certificateCount, now: NOW }));
    expect(journey(0)).toContain("Not checked in:missed");
    expect(journey(1)).toEqual(["Registered:done", "Paid:done", "Certificate ready:done"]);
  });

  it("no check-in step on a webinar or for an online attendee", () => {
    const keys = (event: typeof past, over = {}) => buildJourney({ registration: reg(over), event, surveys: [], certificateCount: 0, now: NOW }).map((s) => s.key);
    expect(keys({ ...past, eventType: "WEBINAR" })).not.toContain("checkin");
    expect(keys(past, { attendanceMode: "VIRTUAL" })).not.toContain("checkin");
  });

  it("a pending or waitlisted registration is not asked to check in or promised a certificate", () => {
    expect(labels(buildJourney({ registration: reg({ status: "PENDING" }), event: past, surveys: [], certificateCount: 0, now: NOW }))).toEqual([
      "Awaiting approval:waiting",
      "Free:done",
    ]);
  });

  it("counts several surveys", () => {
    const steps = buildJourney({
      registration: reg(),
      event: past,
      surveys: [
        { id: "a", name: "A", answered: true, daily: false, open: true, certificate: true },
        { id: "b", name: "B", answered: false, daily: false, open: true, certificate: false },
      ],
      certificateCount: 0,
      now: NOW,
    });
    expect(steps.find((s) => s.key === "survey")).toEqual({ key: "survey", label: "1 of 2 surveys answered", state: "action" });
  });
});

describe("surveyLinesFor", () => {
  const LIVE = [{ id: "q1", type: "rating", label: "How was it?" }];
  const event = (start: string, surveyConfig: unknown = LIVE) => ({ startDate: new Date(start), timezone: "Asia/Dubai", surveyConfig });
  const row = (over: Partial<EventSurveyRow>): EventSurveyRow => ({
    id: "s1",
    eventId: "e1",
    name: "Survey",
    config: LIVE,
    isActive: true,
    gatesCertificates: false,
    responseMode: "ONCE",
    ...over,
  });
  // The organiser's links to r1, all alive, unless a test says otherwise.
  const ALL_LINKS = new Set(["survey:r1", "survey:s1:r1", "survey:cert:r1"]);
  const lines = (input: Partial<Parameters<typeof surveyLinesFor>[0]>) =>
    surveyLinesFor({ registration: { id: "r1", status: "CONFIRMED", surveyCompletedAt: null }, event: event("2026-10-31T05:00:00Z"), surveys: [], responses: [], liveLinks: ALL_LINKS, now: NOW, ...input });

  it("the certificate survey is answered by surveyCompletedAt, its historical signal", () => {
    const cert = row({ id: "cert", name: "Post-event survey", gatesCertificates: true });
    expect(lines({ surveys: [cert] })).toEqual([{ id: "cert", name: "Post-event survey", answered: false, daily: false, open: true, certificate: true }]);
    expect(lines({ surveys: [cert], registration: { id: "r1", status: "CONFIRMED", surveyCompletedAt: NOW } })[0].answered).toBe(true);
  });

  it("an event with questions on its columns but no Survey row still asks its certificate survey", () => {
    expect(lines({ surveys: [] })).toEqual([{ id: null, name: "Post-event survey", answered: false, daily: false, open: true, certificate: true }]);
  });

  it("nothing is asked before the event starts, unless already answered", () => {
    const before = event("2027-01-15T05:00:00Z");
    const extra = row({});
    expect(lines({ event: before, surveys: [extra] })).toEqual([]);
    expect(lines({ event: before, surveys: [extra], responses: [{ surveyId: "s1", registrationId: "r1", dedupKey: "r1" }] })).toHaveLength(1);
  });

  it("a closed or empty survey shows only when answered", () => {
    expect(lines({ event: event("2026-10-31T05:00:00Z", null), surveys: [row({ isActive: false })] })).toEqual([]);
    expect(lines({ event: event("2026-10-31T05:00:00Z", null), surveys: [row({ config: [] })] })).toEqual([]);
    expect(
      lines({ event: event("2026-10-31T05:00:00Z", null), surveys: [row({ isActive: false })], responses: [{ surveyId: "s1", registrationId: "r1", dedupKey: "r1" }] }),
    ).toMatchObject([{ answered: true, open: false }]);
  });

  it("a daily survey counts today's answer only, in the event's time zone", () => {
    const daily = row({ responseMode: "ONCE_PER_DAY" });
    const noCert = event("2026-10-31T05:00:00Z", null);
    expect(lines({ event: noCert, surveys: [daily], responses: [{ surveyId: "s1", registrationId: "r1", dedupKey: "r1:2026-11-09" }] })).toMatchObject([{ answered: true, daily: true }]);
    expect(lines({ event: noCert, surveys: [daily], responses: [{ surveyId: "s1", registrationId: "r1", dedupKey: "r1:2026-11-08" }] })).toMatchObject([{ answered: false }]);
  });

  it("re-issues, never widens: an unanswered survey shows only to someone holding a live link to it", () => {
    const cert = row({ id: "cert", gatesCertificates: true });
    // A no-show the organiser never sent the CME survey to: no button.
    expect(lines({ surveys: [cert], liveLinks: new Set() })).toEqual([]);
    // An extra survey sent to one group: not for the rest of the event.
    expect(lines({ event: event("2026-10-31T05:00:00Z", null), surveys: [row({})], liveLinks: new Set(["survey:r1"]) })).toEqual([]);
    // Answered still shows, link or not.
    expect(lines({ surveys: [cert], liveLinks: new Set(), registration: { id: "r1", status: "CONFIRMED", surveyCompletedAt: NOW } })).toMatchObject([{ answered: true }]);
  });

  it("the CME survey counts a link under either form", () => {
    const cert = row({ id: "cert", gatesCertificates: true });
    expect(lines({ surveys: [cert], liveLinks: new Set(["survey:r1"]) })).toHaveLength(1);
    expect(lines({ surveys: [cert], liveLinks: new Set(["survey:cert:r1"]) })).toHaveLength(1);
    expect(lines({ surveys: [cert], liveLinks: new Set(["survey:cert:other"]) })).toEqual([]);
  });

  it("asks only a place at the event", () => {
    expect(lines({ registration: { id: "r1", status: "WAITLISTED", surveyCompletedAt: null } })).toEqual([]);
  });
});
