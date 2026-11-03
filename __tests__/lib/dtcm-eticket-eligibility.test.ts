import { describe, it, expect } from "vitest";
import { dtcmEligibility, normalisePhone } from "@/lib/dtcm-eticket/eligibility";

const event = {
  requiresDtcmBarcode: true,
  dtcmPerformanceCode: "P1",
  settings: { dtcm: { sections: { t1: { area: "SVIP2", priceTypeCode: "C" } }, environment: "staging", performanceCode: "P1", checkedAt: "x" } },
};
const reg = (over: Record<string, unknown> = {}, attendee: Record<string, unknown> = {}) => ({
  id: "r1",
  status: "CONFIRMED",
  attendanceMode: "IN_PERSON",
  dtcmBarcode: null,
  ticketTypeId: "t1",
  attendee: { title: "PROF", firstName: " Omar ", lastName: "Ali", email: "o@example.com", phone: "050-123 4567", country: "Saudi Arabia", ...attendee },
  ...over,
});

describe("dtcmEligibility", () => {
  it("builds DET's customer from the attendee", () => {
    const out = dtcmEligibility(event, reg(), "staging");
    expect(out).toMatchObject({
      ok: true,
      mapping: { area: "SVIP2", priceTypeCode: "C" },
      customer: { externalId: "r1", title: "Prof", firstName: "Omar", nationality: "SA", countryCode: "SA", phoneNumber: "0501234567" },
    });
  });

  it.each([
    ["DTCM_OFF", { ...event, dtcmPerformanceCode: null }, reg(), "staging"],
    ["CANCELLED", event, reg({ status: "CANCELLED" }), "staging"],
    ["VIRTUAL", event, reg({ attendanceMode: "VIRTUAL" }), "staging"],
    ["ALREADY_HAS_CODE", event, reg({ dtcmBarcode: "X" }), "staging"],
    ["TYPE_NOT_MAPPED", event, reg({ ticketTypeId: "t2" }), "staging"],
    ["MAPPING_STALE", event, reg(), "production"],
    ["MISSING_PHONE", event, reg({}, { phone: "  " }), "staging"],
    ["MISSING_COUNTRY", event, reg({}, { country: "Atlantis" }), "staging"],
    ["MISSING_NAME", event, reg({}, { lastName: " " }), "staging"],
  ] as const)("refuses %s", (reason, ev, r, env) => {
    expect(dtcmEligibility(ev, r, env)).toMatchObject({ ok: false, reason });
  });
});

describe("normalisePhone", () => {
  it("keeps a leading + and the digits", () => {
    expect(normalisePhone("+971 (50) 123-4567")).toBe("+971501234567");
  });
  it("is null for nothing usable", () => {
    expect(normalisePhone("n/a")).toBeNull();
    expect(normalisePhone(null)).toBeNull();
  });
});
