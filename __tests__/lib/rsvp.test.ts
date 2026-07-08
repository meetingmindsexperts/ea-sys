/**
 * Dinner RSVP shared helpers — token, dedup email, headcount aggregation,
 * and the submit-body schema (the pieces that would break the roster
 * totals or the public form contract).
 */
import { describe, it, expect } from "vitest";
import {
  generateRsvpToken,
  normalizeRsvpEmail,
  computeDinnerHeadcounts,
  isAttendingAny,
  rsvpSubmitSchema,
  rsvpDinnerInputSchema,
  type RsvpDinnerLite,
  type RsvpInviteLite,
} from "@/lib/rsvp/rsvp";

describe("generateRsvpToken", () => {
  it("returns a URL-safe, unguessable token that is unique per call", () => {
    const a = generateRsvpToken();
    const b = generateRsvpToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(30);
  });
});

describe("normalizeRsvpEmail", () => {
  it("trims + lowercases for stable de-dup", () => {
    expect(normalizeRsvpEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
});

describe("computeDinnerHeadcounts", () => {
  const dinners: RsvpDinnerLite[] = [
    { id: "d1", name: "Day 1", dinnerAt: new Date() },
    { id: "d2", name: "Day 2", dinnerAt: new Date() },
  ];
  const invites: RsvpInviteLite[] = [
    { status: "RESPONDED", responses: [
      { dinnerId: "d1", attending: true, guestCount: 2 },
      { dinnerId: "d2", attending: false, guestCount: 0 },
    ] },
    { status: "RESPONDED", responses: [
      { dinnerId: "d1", attending: true, guestCount: 0 },
      { dinnerId: "d2", attending: true, guestCount: 1 },
    ] },
    { status: "PENDING", responses: [] },
  ];

  it("counts attendees + guests + total seats per dinner, ignoring non-attending", () => {
    const [d1, d2] = computeDinnerHeadcounts(dinners, invites);
    expect(d1).toEqual({ dinnerId: "d1", attendees: 2, guests: 2, total: 4 });
    expect(d2).toEqual({ dinnerId: "d2", attendees: 1, guests: 1, total: 2 });
  });

  it("returns a zeroed row for a dinner with no responses", () => {
    const rows = computeDinnerHeadcounts(dinners, [{ status: "PENDING", responses: [] }]);
    expect(rows).toEqual([
      { dinnerId: "d1", attendees: 0, guests: 0, total: 0 },
      { dinnerId: "d2", attendees: 0, guests: 0, total: 0 },
    ]);
  });

  it("ignores a response for a since-deleted dinner (no crash, not counted)", () => {
    const rows = computeDinnerHeadcounts(dinners, [
      { status: "RESPONDED", responses: [{ dinnerId: "ghost", attending: true, guestCount: 5 }] },
    ]);
    expect(rows.every((r) => r.total === 0)).toBe(true);
  });
});

describe("isAttendingAny", () => {
  it("true only when RESPONDED and at least one dinner attending", () => {
    expect(isAttendingAny({ status: "RESPONDED", responses: [{ dinnerId: "d1", attending: true, guestCount: 0 }] })).toBe(true);
    expect(isAttendingAny({ status: "RESPONDED", responses: [{ dinnerId: "d1", attending: false, guestCount: 0 }] })).toBe(false);
    expect(isAttendingAny({ status: "PENDING", responses: [{ dinnerId: "d1", attending: true, guestCount: 0 }] })).toBe(false);
  });
});

describe("rsvpSubmitSchema", () => {
  it("accepts a valid submit body", () => {
    const r = rsvpSubmitSchema.safeParse({
      token: "abc",
      dietary: "vegetarian",
      dinners: [{ dinnerId: "d1", attending: true, guestCount: 2 }],
    });
    expect(r.success).toBe(true);
  });
  it("rejects a guest count over the cap", () => {
    const r = rsvpSubmitSchema.safeParse({
      token: "abc",
      dinners: [{ dinnerId: "d1", attending: true, guestCount: 99 }],
    });
    expect(r.success).toBe(false);
  });
});

describe("rsvpDinnerInputSchema", () => {
  it("requires a name and an ISO dinnerAt", () => {
    expect(rsvpDinnerInputSchema.safeParse({ name: "Gala", dinnerAt: new Date().toISOString() }).success).toBe(true);
    expect(rsvpDinnerInputSchema.safeParse({ name: "", dinnerAt: new Date().toISOString() }).success).toBe(false);
    expect(rsvpDinnerInputSchema.safeParse({ name: "Gala", dinnerAt: "not-a-date" }).success).toBe(false);
  });
});
