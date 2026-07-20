/**
 * Pipeline-stage service — the guards that keep the deal state machine sane.
 *
 * The load-bearing rules (CRM review H3 follow-ups): a stage's WON/LOST mapping
 * lives in `terminalOutcome`, so renames are free — but the LAST stage mapped to
 * an outcome may be neither deleted nor unmapped (closeDeal would then refuse
 * every close), and names stay unique per org (every name-keyed lookup — board,
 * reconcile planner — would otherwise pick one of two arbitrarily).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmPipelineStage: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      aggregate: vi.fn(),
    },
    crmDeal: { count: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
}));

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  createStage,
  updateStage,
  deleteStage,
  deriveStageOutcome,
} from "@/crm/services/pipeline-service";

const ORG = "org-1";
const base = { organizationId: ORG, userId: "u-1" };

const stage = (over: Record<string, unknown> = {}) => ({
  id: "s-1",
  organizationId: ORG,
  name: "Won",
  sortOrder: 6,
  isTerminal: true,
  terminalOutcome: "WON",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({} as never);
  // R2-M3: the last-terminal guards now run INSIDE a transaction behind a FOR
  // UPDATE row lock. The tx proxy forwards to the same mocked delegates so the
  // per-test count/delete/updateMany mocks keep working.
  vi.mocked(db.$transaction).mockImplementation((async (fn: unknown) => {
    if (typeof fn === "function") {
      const tx = { crmPipelineStage: db.crmPipelineStage, $queryRaw: vi.fn().mockResolvedValue([]) };
      return (fn as (t: unknown) => unknown)(tx);
    }
    return Promise.all(fn as Array<Promise<unknown>>);
  }) as never);
});

describe("deriveStageOutcome — creation-time convenience only", () => {
  it("recognises the four conventional names", () => {
    expect(deriveStageOutcome("Won")).toBe("WON");
    expect(deriveStageOutcome("  closed won ")).toBe("WON");
    expect(deriveStageOutcome("LOST")).toBe("LOST");
    expect(deriveStageOutcome("Closed Lost")).toBe("LOST");
  });

  it("never guesses from an ambiguous name", () => {
    expect(deriveStageOutcome("Signed & Done")).toBeNull();
    expect(deriveStageOutcome("Archived")).toBeNull();
  });
});

describe("updateStage — rename + outcome remap", () => {
  it("renames a stage (org-bound write)", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage() as never);
    vi.mocked(db.crmPipelineStage.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmPipelineStage.findUniqueOrThrow).mockResolvedValue(stage({ name: "Closed 🎉" }) as never);

    const res = await updateStage({ ...base, stageId: "s-1", name: "Closed 🎉" });

    expect(res.ok).toBe(true);
    expect(db.crmPipelineStage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s-1", organizationId: ORG },
        data: { name: "Closed 🎉" },
      }),
    );
  });

  it("refuses to unmap the LAST stage carrying an outcome (closeDeal would refuse every close)", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage() as never);
    vi.mocked(db.crmPipelineStage.count).mockResolvedValue(0 as never); // no sibling WON stage

    const res = await updateStage({ ...base, stageId: "s-1", terminalOutcome: null });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("LAST_TERMINAL_STAGE");
    expect(db.crmPipelineStage.updateMany).not.toHaveBeenCalled();
  });

  it("allows the remap when a sibling stage still carries the outcome", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage() as never);
    vi.mocked(db.crmPipelineStage.count).mockResolvedValue(1 as never);
    vi.mocked(db.crmPipelineStage.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmPipelineStage.findUniqueOrThrow).mockResolvedValue(stage({ terminalOutcome: null }) as never);

    const res = await updateStage({ ...base, stageId: "s-1", terminalOutcome: null });
    expect(res.ok).toBe(true);
  });

  it("never writes an outcome onto a NON-terminal stage", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(
      stage({ isTerminal: false, terminalOutcome: null, name: "Negotiation" }) as never,
    );
    vi.mocked(db.crmPipelineStage.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmPipelineStage.findUniqueOrThrow).mockResolvedValue(stage({ isTerminal: false }) as never);

    await updateStage({ ...base, stageId: "s-1", terminalOutcome: "WON" });

    const data = vi.mocked(db.crmPipelineStage.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.terminalOutcome).toBeNull();
  });

  it("maps a rename collision to NAME_TAKEN, not UNKNOWN (the H4 rule)", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage({ name: "Proposal", isTerminal: false, terminalOutcome: null }) as never);
    vi.mocked(db.crmPipelineStage.updateMany).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" }) as never,
    );

    const res = await updateStage({ ...base, stageId: "s-1", name: "Negotiation" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NAME_TAKEN");
  });
});

describe("createStage", () => {
  it("derives the outcome from a recognisable terminal name", async () => {
    vi.mocked(db.$transaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        crmPipelineStage: {
          aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 7 } }),
          create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: "s-new", ...data }),
          ),
        },
      };
      return fn(tx);
    }) as never);

    const res = await createStage({ ...base, name: "Closed Won", isTerminal: true });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.stage.terminalOutcome).toBe("WON");
  });

  it("maps a duplicate name to NAME_TAKEN", async () => {
    vi.mocked(db.$transaction).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" }) as never,
    );

    const res = await createStage({ ...base, name: "Won" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NAME_TAKEN");
  });
});

describe("deleteStage — the two refusals", () => {
  it("refuses while the column still holds deals", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage({ isTerminal: false, terminalOutcome: null }) as never);
    vi.mocked(db.crmDeal.count).mockResolvedValue(4 as never);

    const res = await deleteStage({ ...base, stageId: "s-1" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("STAGE_HAS_DEALS");
    expect(db.crmPipelineStage.delete).not.toHaveBeenCalled();
  });

  it("refuses to delete the LAST outcome-mapped column", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage() as never);
    vi.mocked(db.crmDeal.count).mockResolvedValue(0 as never);
    vi.mocked(db.crmPipelineStage.count).mockResolvedValue(0 as never); // no sibling WON

    const res = await deleteStage({ ...base, stageId: "s-1" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("LAST_TERMINAL_STAGE");
    expect(db.crmPipelineStage.delete).not.toHaveBeenCalled();
  });
});
