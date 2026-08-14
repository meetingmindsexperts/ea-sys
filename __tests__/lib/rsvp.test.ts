/**
 * RSVP shared helpers — token, dedup email, headcount aggregation, the
 * submit-body schema, and the SINGLE/MULTI selection rule (the pieces that
 * would break the roster totals or the public form contract).
 */
import { describe, it, expect } from "vitest";
import {
  generateRsvpToken,
  normalizeRsvpEmail,
  computeItemHeadcounts,
  isAttendingAny,
  rsvpSubmitSchema,
  rsvpItemInputSchema,
  rsvpCampaignCreateSchema,
  violatesSelectionMode,
  type RsvpItemLite,
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

describe("computeItemHeadcounts", () => {
  const items: RsvpItemLite[] = [
    { id: "d1", name: "Day 1", startsAt: new Date() },
    { id: "d2", name: "Day 2", startsAt: new Date() },
  ];
  const invites: RsvpInviteLite[] = [
    { status: "RESPONDED", responses: [
      { itemId: "d1", attending: true, guestCount: 2 },
      { itemId: "d2", attending: false, guestCount: 0 },
    ] },
    { status: "RESPONDED", responses: [
      { itemId: "d1", attending: true, guestCount: 0 },
      { itemId: "d2", attending: true, guestCount: 1 },
    ] },
    { status: "PENDING", responses: [] },
  ];

  it("counts attendees + guests + total seats per item, ignoring non-attending", () => {
    const [d1, d2] = computeItemHeadcounts(items, invites);
    expect(d1).toEqual({ itemId: "d1", attendees: 2, guests: 2, total: 4 });
    expect(d2).toEqual({ itemId: "d2", attendees: 1, guests: 1, total: 2 });
  });

  it("returns a zeroed row for an item with no responses", () => {
    const rows = computeItemHeadcounts(items, [{ status: "PENDING", responses: [] }]);
    expect(rows).toEqual([
      { itemId: "d1", attendees: 0, guests: 0, total: 0 },
      { itemId: "d2", attendees: 0, guests: 0, total: 0 },
    ]);
  });

  it("ignores a response for a since-deleted item (no crash, not counted)", () => {
    const rows = computeItemHeadcounts(items, [
      { status: "RESPONDED", responses: [{ itemId: "ghost", attending: true, guestCount: 5 }] },
    ]);
    expect(rows.every((r) => r.total === 0)).toBe(true);
  });
});

describe("isAttendingAny", () => {
  it("true only when RESPONDED and at least one item attending", () => {
    expect(isAttendingAny({ status: "RESPONDED", responses: [{ itemId: "d1", attending: true, guestCount: 0 }] })).toBe(true);
    expect(isAttendingAny({ status: "RESPONDED", responses: [{ itemId: "d1", attending: false, guestCount: 0 }] })).toBe(false);
    expect(isAttendingAny({ status: "PENDING", responses: [{ itemId: "d1", attending: true, guestCount: 0 }] })).toBe(false);
  });
});

describe("violatesSelectionMode", () => {
  // The rule the public POST enforces server-side. A radio group is a hint;
  // this is the thing a crafted POST has to get past.
  it("MULTI never violates, however many are picked", () => {
    expect(violatesSelectionMode("MULTI", 0)).toBe(false);
    expect(violatesSelectionMode("MULTI", 1)).toBe(false);
    expect(violatesSelectionMode("MULTI", 7)).toBe(false);
  });

  it("SINGLE allows zero (declining) and exactly one, rejects two or more", () => {
    // Declining everything must stay valid in SINGLE mode — a workshop RSVP
    // where "I'm not coming to any" is unrepresentable would force people to
    // pick one they aren't attending.
    expect(violatesSelectionMode("SINGLE", 0)).toBe(false);
    expect(violatesSelectionMode("SINGLE", 1)).toBe(false);
    expect(violatesSelectionMode("SINGLE", 2)).toBe(true);
    expect(violatesSelectionMode("SINGLE", 10)).toBe(true);
  });
});

describe("rsvpSubmitSchema", () => {
  it("accepts a valid submit body", () => {
    const r = rsvpSubmitSchema.safeParse({
      token: "abc",
      dietary: "vegetarian",
      items: [{ itemId: "d1", attending: true, guestCount: 2 }],
    });
    expect(r.success).toBe(true);
  });
  it("rejects a guest count over the cap", () => {
    const r = rsvpSubmitSchema.safeParse({
      token: "abc",
      items: [{ itemId: "d1", attending: true, guestCount: 99 }],
    });
    expect(r.success).toBe(false);
  });
});

describe("rsvpItemInputSchema", () => {
  it("requires a name and an ISO startsAt", () => {
    expect(rsvpItemInputSchema.safeParse({ name: "Gala", startsAt: new Date().toISOString() }).success).toBe(true);
    expect(rsvpItemInputSchema.safeParse({ name: "", startsAt: new Date().toISOString() }).success).toBe(false);
    expect(rsvpItemInputSchema.safeParse({ name: "Gala", startsAt: "not-a-date" }).success).toBe(false);
  });
});

describe("rsvpCampaignCreateSchema", () => {
  it("accepts a bare name — config all defaults to today's dinner behavior", () => {
    const r = rsvpCampaignCreateSchema.safeParse({ name: "Gala Dinner" });
    expect(r.success).toBe(true);
  });

  it("accepts the combined create form (campaign + its first item in one payload)", () => {
    // This is what keeps the campaign INVISIBLE for a single-dinner event:
    // one form, one request, same three steps as before (plan §2a).
    const r = rsvpCampaignCreateSchema.safeParse({
      name: "Gala Dinner",
      allowGuests: true,
      collectDietary: true,
      firstItem: { name: "Gala Dinner", startsAt: new Date().toISOString() },
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown selection mode", () => {
    const r = rsvpCampaignCreateSchema.safeParse({ name: "X", selectionMode: "MAYBE" });
    expect(r.success).toBe(false);
  });

  it("rejects a firstItem with no start time", () => {
    const r = rsvpCampaignCreateSchema.safeParse({ name: "X", firstItem: { name: "Y" } });
    expect(r.success).toBe(false);
  });
});
