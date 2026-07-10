/**
 * expireOpenCheckoutSessionOnCancel (payments review H2 sub-item).
 * Pins: expires + clears when a session pointer exists; no-ops without one;
 * a Stripe error (already completed/expired) still clears and NEVER throws —
 * a cancel must not fail because Stripe is unreachable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, sessionsExpire } = vi.hoisted(() => ({
  mockDb: { registration: { findUnique: vi.fn(), update: vi.fn() } },
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  sessionsExpire: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { expire: sessionsExpire } } }),
}));

import { expireOpenCheckoutSessionOnCancel } from "@/lib/checkout-session-cleanup";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.update.mockResolvedValue({});
  sessionsExpire.mockResolvedValue({});
});

describe("expireOpenCheckoutSessionOnCancel", () => {
  it("expires the open session and clears the pointer", async () => {
    mockDb.registration.findUnique.mockResolvedValue({ stripeCheckoutSessionId: "cs_open" });
    await expireOpenCheckoutSessionOnCancel("reg1", "test");
    expect(sessionsExpire).toHaveBeenCalledWith("cs_open");
    expect(mockDb.registration.update).toHaveBeenCalledWith({
      where: { id: "reg1" },
      data: { stripeCheckoutSessionId: null },
    });
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "checkout-session:expired-on-cancel", sessionId: "cs_open" }),
    );
  });

  it("no-ops when the registration holds no open session", async () => {
    mockDb.registration.findUnique.mockResolvedValue({ stripeCheckoutSessionId: null });
    await expireOpenCheckoutSessionOnCancel("reg1", "test");
    expect(sessionsExpire).not.toHaveBeenCalled();
    expect(mockDb.registration.update).not.toHaveBeenCalled();
  });

  it("a Stripe error (already completed/expired) still clears the pointer and never throws", async () => {
    mockDb.registration.findUnique.mockResolvedValue({ stripeCheckoutSessionId: "cs_done" });
    sessionsExpire.mockRejectedValue(new Error("Session is not open"));
    await expect(expireOpenCheckoutSessionOnCancel("reg1", "test")).resolves.toBeUndefined();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "checkout-session:expire-failed" }),
    );
    expect(mockDb.registration.update).toHaveBeenCalledWith({
      where: { id: "reg1" },
      data: { stripeCheckoutSessionId: null },
    });
  });

  it("never throws even when the DB read itself fails", async () => {
    mockDb.registration.findUnique.mockRejectedValue(new Error("pool gone"));
    await expect(expireOpenCheckoutSessionOnCancel("reg1", "test")).resolves.toBeUndefined();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "checkout-session:cleanup-failed" }),
    );
  });
});
