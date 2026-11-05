/**
 * registrant-access.ts: which registrations belong to a signed-in person
 * (Nov 5, 2026; docs/ACCOUNT_CONFIRMATION_PLAN.md). An address on a
 * registration is only trusted once the account has proven it owns it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { user: { findUnique: vi.fn() }, registration: { updateMany: vi.fn(), findFirst: vi.fn() }, speaker: { updateMany: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { hasUnclaimedRegistrations, linkConfirmedRegistrations, linkConfirmedSpeakers, loadRegistrantScope, ownRegistrationWhere } from "@/lib/registrant-access";

const confirmed = { userId: "u1", email: "anna@example.com", confirmed: true };
const unconfirmed = { ...confirmed, confirmed: false };

beforeEach(() => vi.clearAllMocks());

describe("loadRegistrantScope", () => {
  it("reads the address and the proof from the database, lower-cased", async () => {
    mockDb.user.findUnique.mockResolvedValue({ email: " Anna@Example.com ", emailConfirmedAt: new Date() });
    expect(await loadRegistrantScope("u1")).toEqual(confirmed);
    mockDb.user.findUnique.mockResolvedValue({ email: "anna@example.com", emailConfirmedAt: null });
    expect((await loadRegistrantScope("u1"))?.confirmed).toBe(false);
    mockDb.user.findUnique.mockResolvedValue(null);
    expect(await loadRegistrantScope("gone")).toBeNull();
  });
});

describe("ownRegistrationWhere", () => {
  it("unconfirmed: linked registrations only", () => {
    expect(ownRegistrationWhere(unconfirmed)).toEqual({ userId: "u1" });
  });
  it("confirmed: linked, or carrying the address in any case", () => {
    expect(ownRegistrationWhere(confirmed)).toEqual({
      OR: [{ userId: "u1" }, { userId: null, attendee: { email: { equals: "anna@example.com", mode: "insensitive" } } }],
    });
  });
  it("never matches by a blank address, confirmed or not", () => {
    expect(ownRegistrationWhere({ ...confirmed, email: "" })).toEqual({ userId: "u1" });
  });
});

describe("linkConfirmedRegistrations", () => {
  it("links nothing for an unconfirmed account", async () => {
    expect(await linkConfirmedRegistrations(unconfirmed)).toBe(0);
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });
  it("links only unlinked registrations on the address for a confirmed one", async () => {
    mockDb.registration.updateMany.mockResolvedValue({ count: 2 });
    expect(await linkConfirmedRegistrations(confirmed)).toBe(2);
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { userId: null, attendee: { email: { equals: "anna@example.com", mode: "insensitive" } } },
      data: { userId: "u1" },
    });
  });
});

describe("hasUnclaimedRegistrations", () => {
  it("is false for a confirmed account without asking the database", async () => {
    expect(await hasUnclaimedRegistrations(confirmed)).toBe(false);
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });
  it("looks for one on the address not linked to this account, unlinked rows included", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1" });
    expect(await hasUnclaimedRegistrations(unconfirmed)).toBe(true);
    expect(mockDb.registration.findFirst.mock.calls[0][0].where).toEqual({
      OR: [{ userId: null }, { userId: { not: "u1" } }],
      attendee: { email: { equals: "anna@example.com", mode: "insensitive" } },
    });
  });
});

describe("a registration already linked to another account", () => {
  it("is never matched by address, even for a confirmed account", () => {
    const where = ownRegistrationWhere(confirmed) as { OR: Record<string, unknown>[] };
    expect(where.OR[1]).toMatchObject({ userId: null });
  });
});

describe("linkConfirmedSpeakers", () => {
  it("claims nothing for an unconfirmed account", async () => {
    expect(await linkConfirmedSpeakers(unconfirmed)).toBe(0);
    expect(mockDb.speaker.updateMany).not.toHaveBeenCalled();
  });
  it("claims only unclaimed speaker records on the address", async () => {
    mockDb.speaker.updateMany.mockResolvedValue({ count: 1 });
    expect(await linkConfirmedSpeakers(confirmed)).toBe(1);
    expect(mockDb.speaker.updateMany).toHaveBeenCalledWith({
      where: { userId: null, email: { equals: "anna@example.com", mode: "insensitive" } },
      data: { userId: "u1" },
    });
  });
});
