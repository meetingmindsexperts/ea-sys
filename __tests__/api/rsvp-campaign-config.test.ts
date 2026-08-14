/**
 * Turning `allowGuests` OFF must reconcile the answers already on file.
 *
 * Config that changes what a field MEANS has to migrate the field. Without
 * this the headcount tile keeps summing guestCount ("20 attending +15 guests ·
 * 35 seats") while the CSV drops the guest columns entirely — so the organizer
 * hands the caterer an export whose total nobody can explain, and the invitee
 * can't correct it because the input is gone from their form.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    rsvpCampaign: { findFirst: vi.fn(), updateMany: vi.fn() },
    rsvpResponse: { updateMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: unknown) => unknown) => mockDb.$transaction(fn),
}));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "u1", organizationId: "org1", role: "ADMIN" } }),
}));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null }));
vi.mock("@/lib/event-access", () => ({ buildEventAccessWhere: () => ({ id: "ev1" }) }));

import { PUT } from "@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/route";

const params = Promise.resolve({ eventId: "ev1", campaignId: "c1" });
const base = {
  id: "c1", eventId: "ev1", organizationId: "org1", name: "Gala Dinner",
  description: null, selectionMode: "MULTI", allowGuests: true, collectDietary: true,
  isActive: true, sortOrder: 0, createdAt: new Date(), updatedAt: new Date(),
};
const put = (body: Record<string, unknown>) =>
  PUT({ json: async () => body } as unknown as Request, { params });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  mockDb.rsvpCampaign.findFirst.mockResolvedValue(base);
  mockDb.rsvpCampaign.updateMany.mockResolvedValue({ count: 1 });
  mockDb.rsvpResponse.updateMany.mockResolvedValue({ count: 15 });
  mockDb.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<void>) => fn(mockDb));
});

describe("allowGuests true -> false", () => {
  it("zeroes existing guest counts for the campaign, in the same transaction", async () => {
    await put({ allowGuests: false });
    expect(mockDb.rsvpResponse.updateMany).toHaveBeenCalledWith({
      // Scoped through the invite relation — never event-wide, or it would
      // wipe the OTHER RSVP's guest counts on the same event.
      where: { invite: { campaignId: "c1" }, guestCount: { gt: 0 } },
      data: { guestCount: 0 },
    });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });

  it("records how many were cleared in the audit row", async () => {
    await put({ allowGuests: false });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.guestsCleared).toBe(15);
  });
});

describe("everything else leaves responses alone", () => {
  it("turning guests ON does not touch responses", async () => {
    mockDb.rsvpCampaign.findFirst.mockResolvedValue({ ...base, allowGuests: false });
    await put({ allowGuests: true });
    expect(mockDb.rsvpResponse.updateMany).not.toHaveBeenCalled();
  });

  it("re-sending allowGuests:false when it is ALREADY false is a no-op", async () => {
    // Only a real true->false transition reconciles; an idempotent PUT must not
    // re-run the destructive clear.
    mockDb.rsvpCampaign.findFirst.mockResolvedValue({ ...base, allowGuests: false });
    await put({ allowGuests: false });
    expect(mockDb.rsvpResponse.updateMany).not.toHaveBeenCalled();
  });

  it("an unrelated rename does not touch responses", async () => {
    await put({ name: "Gala Dinner 2026" });
    expect(mockDb.rsvpResponse.updateMany).not.toHaveBeenCalled();
  });
});
