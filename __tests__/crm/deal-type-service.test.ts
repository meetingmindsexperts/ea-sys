/**
 * CRM deal-type service — the org-configurable business-line list.
 * Pins: seed-once idempotency, the append sortOrder, the compound-where org bind
 * on mutations (defence #1), name validation, and archive/restore.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { txMock } = vi.hoisted(() => ({ txMock: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    crmDealType: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    $transaction: txMock,
  },
  // tenantTransaction with the flag off IS db.$transaction — delegate so the
  // reorder path (interactive tenantTransaction) drives the mocked tx.
  tenantTransaction: (fn: unknown) => (txMock as (f: unknown) => unknown)(fn),
}));

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  DEFAULT_DEAL_TYPES,
  ensureDealTypes,
  createDealType,
  updateDealType,
} from "@/crm/services/deal-type-service";

const ORG = "org-1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureDealTypes — seed once", () => {
  it("seeds the default list when the org has none", async () => {
    vi.mocked(db.crmDealType.findMany)
      .mockResolvedValueOnce([] as never) // pre-seed check: empty
      .mockResolvedValueOnce([{ id: "t1" }] as never); // post-seed read
    vi.mocked(db.crmDealType.createMany).mockResolvedValue({ count: DEFAULT_DEAL_TYPES.length } as never);

    await ensureDealTypes(ORG);

    expect(db.crmDealType.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: DEFAULT_DEAL_TYPES.map((name, i) => ({ organizationId: ORG, name, sortOrder: i })),
        skipDuplicates: true,
      }),
    );
  });

  it("does NOT re-seed when the org already owns a list", async () => {
    vi.mocked(db.crmDealType.findMany).mockResolvedValueOnce([{ id: "t1" }] as never);
    await ensureDealTypes(ORG);
    expect(db.crmDealType.createMany).not.toHaveBeenCalled();
  });
});

describe("createDealType", () => {
  it("rejects an empty name", async () => {
    const res = await createDealType({ organizationId: ORG, name: "   " });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NAME_REQUIRED");
    expect(db.crmDealType.create).not.toHaveBeenCalled();
  });

  it("appends at max(sortOrder)+1", async () => {
    vi.mocked(db.crmDealType.aggregate).mockResolvedValue({ _max: { sortOrder: 4 } } as never);
    vi.mocked(db.crmDealType.create).mockResolvedValue({ id: "t9", name: "New Type", sortOrder: 5 } as never);

    const res = await createDealType({ organizationId: ORG, name: "New Type" });

    expect(res.ok).toBe(true);
    expect(db.crmDealType.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organizationId: ORG, name: "New Type", sortOrder: 5 }) }),
    );
  });

  it("maps a P2002 to NAME_TAKEN", async () => {
    vi.mocked(db.crmDealType.aggregate).mockResolvedValue({ _max: { sortOrder: null } } as never);
    vi.mocked(db.crmDealType.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
    );
    const res = await createDealType({ organizationId: ORG, name: "Dup" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NAME_TAKEN");
  });
});

describe("updateDealType — org-bound, archive/restore", () => {
  it("binds the write to the org (compound-where) and 404s a foreign id", async () => {
    vi.mocked(db.crmDealType.updateMany).mockResolvedValue({ count: 0 } as never);
    const res = await updateDealType({ dealTypeId: "foreign", organizationId: ORG, name: "X" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("DEAL_TYPE_NOT_FOUND");
    const call = vi.mocked(db.crmDealType.updateMany).mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(call.where).toMatchObject({ id: "foreign", organizationId: ORG });
  });

  it("archives by stamping archivedAt", async () => {
    vi.mocked(db.crmDealType.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDealType.findUniqueOrThrow).mockResolvedValue({ id: "t1", archivedAt: new Date() } as never);
    const res = await updateDealType({ dealTypeId: "t1", organizationId: ORG, archived: true });
    expect(res.ok).toBe(true);
    const call = vi.mocked(db.crmDealType.updateMany).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.archivedAt).toBeInstanceOf(Date);
  });

  it("restores by clearing archivedAt", async () => {
    vi.mocked(db.crmDealType.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDealType.findUniqueOrThrow).mockResolvedValue({ id: "t1", archivedAt: null } as never);
    const res = await updateDealType({ dealTypeId: "t1", organizationId: ORG, archived: false });
    expect(res.ok).toBe(true);
    const call = vi.mocked(db.crmDealType.updateMany).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.archivedAt).toBeNull();
  });

  it("rejects an empty update", async () => {
    const res = await updateDealType({ dealTypeId: "t1", organizationId: ORG });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NO_FIELDS");
  });
});
