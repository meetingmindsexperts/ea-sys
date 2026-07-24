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
      findMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// tenantTransaction with the flag off IS db.$transaction — delegate so the
// merge test's dynamically-set mockDb.$transaction still drives it (the C1
// sweep switched mergeBillingAccounts onto tenantTransaction).
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: unknown) => unknown) =>
    (mockDb as unknown as { $transaction: (f: (tx: unknown) => unknown) => unknown }).$transaction(fn),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import {
  createBillingAccount,
  updateBillingAccount,
  findOrCreateBillingAccount,
  mergeBillingAccounts,
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
    // C1: org binding is now atomic with the write (compound-where).
    expect(updArg.where).toEqual({ id: "ba-1", organizationId: "org-1" });
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

describe("findOrCreateBillingAccount — event-level entry, org consolidation", () => {
  it("NAME_REQUIRED when blank (no create)", async () => {
    const res = await findOrCreateBillingAccount({ ...CALLER, name: "  " });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NAME_REQUIRED");
    expect(mockDb.billingAccount.create).not.toHaveBeenCalled();
  });

  it("reuses an existing org payer on exact (case-insensitive) name — no create", async () => {
    mockDb.billingAccount.findFirst.mockResolvedValue({ id: "ba-1", name: "Cleveland Clinic", needsReview: false });
    const res = await findOrCreateBillingAccount({ ...CALLER, name: "  cleveland clinic " });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reused).toBe(true);
      expect(res.billingAccount.id).toBe("ba-1");
    }
    expect(mockDb.billingAccount.create).not.toHaveBeenCalled();
  });

  it("creates a new payer when no name matches (not flagged)", async () => {
    mockDb.billingAccount.findFirst.mockResolvedValue(null);
    mockDb.billingAccount.findMany.mockResolvedValue([{ name: "Acme Corp" }]);
    mockDb.billingAccount.create.mockResolvedValue({ id: "ba-2", name: "Pfizer", needsReview: false });
    const res = await findOrCreateBillingAccount({ ...CALLER, name: "Pfizer" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reused).toBe(false);
      expect(res.flaggedReview).toBe(false);
    }
    expect(mockDb.billingAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ needsReview: false }) }),
    );
  });

  it("flags needsReview when a near-duplicate name exists (fuzzy)", async () => {
    mockDb.billingAccount.findFirst.mockResolvedValue(null);
    mockDb.billingAccount.findMany.mockResolvedValue([{ name: "Cleveland Clinic" }]);
    mockDb.billingAccount.create.mockResolvedValue({ id: "ba-3", name: "Cleveland Clinic Foundation", needsReview: true });
    const res = await findOrCreateBillingAccount({ ...CALLER, name: "Cleveland Clinic Foundation" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.flaggedReview).toBe(true);
    expect(mockDb.billingAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ needsReview: true }) }),
    );
  });
});

describe("mergeBillingAccounts", () => {
  // The merge runs inside one $transaction; route it to per-model tx mocks so
  // the tests can control both lookups + count the re-points.
  function setupMergeTx(opts: {
    survivor?: { id: string; name: string } | null;
    duplicate?: { id: string; name: string } | null;
    dupJunctions?: Array<{ id: string; eventId: string }>;
    survivorJunctions?: Array<{ eventId: string }>;
    regCount?: number;
  }) {
    const tx = {
      billingAccount: {
        findFirst: vi.fn().mockImplementation(({ where }: { where: { id: string } }) => {
          if (where.id === "ba-keep") return Promise.resolve(opts.survivor ?? { id: "ba-keep", name: "Keep" });
          if (where.id === "ba-dup") return Promise.resolve(opts.duplicate ?? { id: "ba-dup", name: "Dup" });
          return Promise.resolve(null);
        }),
        delete: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      registration: {
        updateMany: vi.fn().mockResolvedValue({ count: opts.regCount ?? 0 }),
      },
      eventBillingAccount: {
        findMany: vi.fn().mockImplementation(({ where }: { where: { billingAccountId: string } }) =>
          Promise.resolve(
            where.billingAccountId === "ba-dup"
              ? opts.dupJunctions ?? []
              : opts.survivorJunctions ?? [],
          ),
        ),
        deleteMany: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({}),
      },
    };
    (mockDb as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction = vi
      .fn()
      .mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));
    return tx;
  }

  it("SAME_ACCOUNT when survivor === duplicate", async () => {
    const res = await mergeBillingAccounts({
      ...CALLER, survivorId: "ba-1", duplicateId: "ba-1",
    });
    expect(res).toMatchObject({ ok: false, code: "SAME_ACCOUNT" });
  });

  it("NOT_FOUND when either payer is missing / foreign-org", async () => {
    setupMergeTx({ duplicate: null });
    const tx = setupMergeTx({});
    tx.billingAccount.findFirst.mockResolvedValue(null);
    const res = await mergeBillingAccounts({
      ...CALLER, survivorId: "ba-keep", duplicateId: "ba-dup",
    });
    expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(tx.billingAccount.delete).not.toHaveBeenCalled();
  });

  it("re-points registrations + junctions, drops overlapping attachments, deletes the duplicate, clears needsReview", async () => {
    const tx = setupMergeTx({
      regCount: 3,
      dupJunctions: [
        { id: "j1", eventId: "ev-shared" }, // survivor already attached → drop
        { id: "j2", eventId: "ev-only-dup" }, // move to survivor
      ],
      survivorJunctions: [{ eventId: "ev-shared" }],
    });

    const res = await mergeBillingAccounts({
      ...CALLER, survivorId: "ba-keep", duplicateId: "ba-dup",
    });

    expect(res).toMatchObject({
      ok: true,
      merge: { registrationsRepointed: 3, eventsRepointed: 1 },
    });
    expect(tx.registration.updateMany).toHaveBeenCalledWith({
      where: { billingAccountId: "ba-dup" },
      data: { billingAccountId: "ba-keep" },
    });
    expect(tx.eventBillingAccount.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["j1"] } },
    });
    expect(tx.eventBillingAccount.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["j2"] } },
      data: { billingAccountId: "ba-keep" },
    });
    // C1: the survivor/duplicate mutations are compound-where org-bound.
    expect(tx.billingAccount.delete).toHaveBeenCalledWith({
      where: { id: "ba-dup", organizationId: "org-1" },
    });
    expect(tx.billingAccount.update).toHaveBeenCalledWith({
      where: { id: "ba-keep", organizationId: "org-1" },
      data: { needsReview: false },
    });
    // Post-commit audit row on the survivor.
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "MERGE", entityId: "ba-keep" }),
      }),
    );
  });
});
