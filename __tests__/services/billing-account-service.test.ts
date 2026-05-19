/**
 * Unit tests for src/services/billing-account-service.ts — the reusable
 * org-scoped third-party payer behind "charge to another account".
 * Pins: name validation, P2002 dedupe → DUPLICATE_NAME (with existing id
 * in meta), org-scoped update (IDOR), soft-delete via isActive, and that
 * a fire-and-forget audit row is written with the caller source.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockDb: {
    billingAccount: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import {
  createBillingAccount,
  updateBillingAccount,
} from "@/services/billing-account-service";

const CALLER = {
  organizationId: "org-1",
  userId: "user-1",
  source: "rest" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("createBillingAccount", () => {
  it("NAME_REQUIRED when name is blank", async () => {
    const res = await createBillingAccount({ ...CALLER, name: "   " });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NAME_REQUIRED");
    expect(mockDb.billingAccount.create).not.toHaveBeenCalled();
  });

  it("happy path: trims name, normalizes empties to null, writes audit with source", async () => {
    mockDb.billingAccount.create.mockResolvedValue({ id: "ba-1", name: "Cleveland Clinic" });

    const res = await createBillingAccount({
      ...CALLER,
      name: "  Cleveland Clinic ",
      type: "INSTITUTION",
      email: "",
      taxNumber: "TRN-1",
      requestIp: "1.2.3.4",
    });

    expect(res.ok).toBe(true);
    const createArg = mockDb.billingAccount.create.mock.calls[0][0];
    expect(createArg.data.name).toBe("Cleveland Clinic");
    expect(createArg.data.email).toBeNull(); // "" → null
    expect(createArg.data.organizationId).toBe("org-1");
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: "BillingAccount",
          changes: expect.objectContaining({ source: "rest", ip: "1.2.3.4" }),
        }),
      }),
    );
  });

  it("DUPLICATE_NAME on the (organizationId,name) unique violation, surfaces existing id", async () => {
    mockDb.billingAccount.create.mockRejectedValue({ code: "P2002" });
    mockDb.billingAccount.findFirst.mockResolvedValue({
      id: "ba-existing",
      name: "Pfizer",
      isActive: true,
    });

    const res = await createBillingAccount({ ...CALLER, name: "Pfizer" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("DUPLICATE_NAME");
      expect(res.meta?.existingId).toBe("ba-existing");
    }
  });
});

describe("updateBillingAccount", () => {
  it("NOT_FOUND when the id isn't in the caller's org (IDOR-safe)", async () => {
    mockDb.billingAccount.findFirst.mockResolvedValue(null);
    const res = await updateBillingAccount({
      ...CALLER,
      billingAccountId: "ba-other-org",
      name: "Hack",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NOT_FOUND");
    expect(mockDb.billingAccount.update).not.toHaveBeenCalled();
  });

  it("soft-delete: isActive:false flows through without a hard delete", async () => {
    mockDb.billingAccount.findFirst.mockResolvedValue({ id: "ba-1" });
    mockDb.billingAccount.update.mockResolvedValue({ id: "ba-1", isActive: false });

    const res = await updateBillingAccount({
      ...CALLER,
      billingAccountId: "ba-1",
      isActive: false,
    });

    expect(res.ok).toBe(true);
    const updArg = mockDb.billingAccount.update.mock.calls[0][0];
    expect(updArg.where).toEqual({ id: "ba-1" });
    expect(updArg.data.isActive).toBe(false);
  });

  it("rejects a blank name on update", async () => {
    mockDb.billingAccount.findFirst.mockResolvedValue({ id: "ba-1" });
    const res = await updateBillingAccount({
      ...CALLER,
      billingAccountId: "ba-1",
      name: "  ",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NAME_REQUIRED");
  });
});
