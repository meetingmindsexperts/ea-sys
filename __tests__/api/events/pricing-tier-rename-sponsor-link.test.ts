/**
 * A sponsor link is stored by rate NAME (code-required-tiers.ts), so renaming
 * a marked rate must carry the mark to the new name, or the renamed $0 rate
 * would open to anyone with the link (review of c4a12f28, Oct 16, 2026).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockUpdateEventSettings } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    pricingTier: { findFirst: vi.fn(), update: vi.fn() },
  },
  mockUpdateEventSettings: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: { set: vi.fn() } }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: mockUpdateEventSettings }));

import { PUT } from "@/app/api/events/[eventId]/tickets/[ticketId]/tiers/[tierId]/route";

const params = { params: Promise.resolve({ eventId: "ev-1", ticketId: "tt-1", tierId: "tier-1" }) };
const req = (body: unknown) => new Request("http://localhost/api/x", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Runs the route's settings patch against `settings` and returns the result. */
const patched = (settings: Record<string, unknown>) => {
  const patch = mockUpdateEventSettings.mock.calls[0][1] as (cur: Record<string, unknown>) => Record<string, unknown>;
  return patch(settings);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org-1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev-1" });
  mockDb.pricingTier.findFirst.mockResolvedValueOnce({ id: "tier-1", name: "Inclusive", soldCount: 0 }).mockResolvedValue(null);
  mockDb.pricingTier.update.mockResolvedValue({ id: "tier-1", name: "Sponsored" });
  mockUpdateEventSettings.mockResolvedValue(undefined);
});

describe("PUT tier rename keeps a sponsor link", () => {
  it("marks the new name before renaming, and keeps the old one", async () => {
    const res = await PUT(req({ name: "Sponsored" }), params);
    expect(res.status).toBe(200);
    expect(mockUpdateEventSettings).toHaveBeenCalledWith("ev-1", expect.any(Function));
    expect(mockUpdateEventSettings.mock.invocationCallOrder[0]).toBeLessThan(mockDb.pricingTier.update.mock.invocationCallOrder[0]);
    expect(patched({ timezone: "Asia/Dubai", codeRequiredTiers: ["inclusive"] })).toEqual({
      timezone: "Asia/Dubai",
      codeRequiredTiers: ["inclusive", "sponsored"],
    });
  });

  it("leaves the settings alone when the old name was not a sponsor link", async () => {
    await PUT(req({ name: "Sponsored" }), params);
    const before = { codeRequiredTiers: ["early-bird"] };
    expect(patched(before)).toBe(before);
  });

  it("does not touch the settings when the name is unchanged", async () => {
    await PUT(req({ price: 10 }), params);
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
  });
});
