/**
 * Deal service — the concurrency-critical paths.
 *
 * A kanban board is the most concurrent surface in the product: two people have
 * it open, both drag the same card, both releases fire. The whole design of
 * moveDealStage() is to make that safe, so that is what these tests pin.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmDeal: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    crmPipelineStage: { findFirst: vi.fn() },
    crmCompany: { findFirst: vi.fn() },
    contact: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    crmActivity: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { db } from "@/lib/db";
import { createDeal, moveDealStage, closeDeal } from "@/crm/services/deal-service";

const ORG = "org-1";
const base = { organizationId: ORG, userId: "u-1", source: "rest" as const };

const stage = (over: Partial<{ id: string; name: string; isTerminal: boolean }> = {}) => ({
  id: "s-neg",
  organizationId: ORG,
  name: "Negotiation",
  sortOrder: 3,
  isTerminal: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({} as never);
});

describe("moveDealStage — the two-people-one-card race", () => {
  it("moves the deal when it is still in the stage the mover saw", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage({ id: "s-prop", name: "Proposal" }) as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", stageId: "s-prop", eventId: null } as never);

    const res = await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-cont", toStageId: "s-prop" });

    expect(res.ok).toBe(true);
    // THE assertion: the previous stage is a PRECONDITION of the write, not just
    // a value we overwrite. Without `stageId: fromStageId` in the where-clause
    // this is last-write-wins.
    expect(db.crmDeal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "d-1",
          organizationId: ORG,
          stageId: "s-cont",
        }),
      }),
    );
  });

  it("LOSES the race with 409 STAGE_CHANGED when someone else moved the card first", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage({ id: "s-prop" }) as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 0 } as never); // claim lost
    // …and the deal does exist — it just isn't where the mover thought.
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", stageId: "s-won" } as never);

    const res = await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-cont", toStageId: "s-prop" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("STAGE_CHANGED");
    // The UI needs to know where it actually is, to roll back to the truth.
    expect(res.meta).toMatchObject({ currentStageId: "s-won" });
  });

  it("distinguishes a lost race from a genuinely missing deal", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage() as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(null as never); // no such deal in this org

    const res = await moveDealStage({ ...base, dealId: "nope", fromStageId: "s-a", toStageId: "s-b" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // These mean very different things to the person at the board, so they must
    // not collapse into one error.
    expect(res.code).toBe("DEAL_NOT_FOUND");
  });

  it("refuses a stage id belonging to another org (IDOR)", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(null as never); // resolveStage binds org

    const res = await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-a", toStageId: "other-orgs-stage" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("STAGE_NOT_FOUND");
    expect(db.crmDeal.updateMany).not.toHaveBeenCalled(); // never reached the write
  });

  it("dragging into the terminal Won column closes the deal and stamps wonAt", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage({ id: "s-won", name: "Won", isTerminal: true }) as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", status: "WON", eventId: null } as never);

    const res = await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-neg", toStageId: "s-won" });

    expect(res.ok).toBe(true);
    const data = vi.mocked(db.crmDeal.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    // The stage and the status must never disagree about what's won — otherwise
    // the board and the revenue report tell different stories.
    expect(data.status).toBe("WON");
    expect(data.wonAt).toBeInstanceOf(Date);
    expect(data.lostAt).toBeNull();
  });

  it("dragging back OUT of a terminal column reopens the deal and clears the stamps", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage({ id: "s-neg", isTerminal: false }) as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", status: "OPEN", eventId: null } as never);

    await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-won", toStageId: "s-neg" });

    const data = vi.mocked(db.crmDeal.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.status).toBe("OPEN");
    // A reopened deal must not linger in a "won in July" report.
    expect(data.wonAt).toBeNull();
    expect(data.lostAt).toBeNull();
  });

  it("does NOT invent an outcome for an ambiguously-named terminal stage", async () => {
    // An org renames its terminal column to "Archived". We must not guess "won" —
    // that would put fictional money in a revenue report.
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage({ id: "s-arch", name: "Archived", isTerminal: true }) as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", eventId: null } as never);

    await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-neg", toStageId: "s-arch" });

    const data = vi.mocked(db.crmDeal.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.status).toBe("OPEN");
    expect(data.wonAt).toBeNull();
  });
});

describe("closeDeal — double-close guard", () => {
  it("closes an OPEN deal as WON", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue({ id: "s-won" } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({
      id: "d-1", status: "WON", dealValue: 40000, currency: "USD", eventId: "e-1", lostReason: null,
    } as never);

    const res = await closeDeal({ ...base, dealId: "d-1", outcome: "WON" });

    expect(res.ok).toBe(true);
    expect(db.crmDeal.updateMany).toHaveBeenCalledWith(
      // The claim requires status OPEN — this is what stops a double-click
      // re-stamping wonAt and corrupting "deals won in July".
      expect.objectContaining({ where: expect.objectContaining({ status: "OPEN" }) }),
    );
  });

  it("409s ALREADY_CLOSED rather than re-stamping a won deal", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue({ id: "s-won" } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", status: "WON" } as never);

    const res = await closeDeal({ ...base, dealId: "d-1", outcome: "WON" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("ALREADY_CLOSED");
  });
});

describe("createDeal — relations are bound to the caller's org", () => {
  it("rejects an eventId from another org", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage() as never);
    vi.mocked(db.event.findFirst).mockResolvedValue(null as never); // not in this org

    const res = await createDeal({ ...base, name: "Abbott — Gold", stageId: "s-neg", eventId: "other-orgs-event" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("EVENT_NOT_FOUND");
    expect(db.crmDeal.create).not.toHaveBeenCalled();
  });

  it("rejects an owner who is not a member of this org", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage() as never);
    vi.mocked(db.user.findFirst).mockResolvedValue(null as never);

    const res = await createDeal({ ...base, name: "Abbott", stageId: "s-neg", ownerId: "outsider" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("OWNER_NOT_FOUND");
  });

  it("creates with the event link — the module's whole differentiator", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage() as never);
    vi.mocked(db.event.findFirst).mockResolvedValue({ id: "e-bridges" } as never);
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue({ id: "c-abbott" } as never);
    vi.mocked(db.crmDeal.create).mockResolvedValue({ id: "d-1", eventId: "e-bridges" } as never);

    const res = await createDeal({
      ...base,
      name: "Abbott — BRIDGES 2026 Gold",
      stageId: "s-neg",
      companyId: "c-abbott",
      eventId: "e-bridges",
      dealValue: 40000,
    });

    expect(res.ok).toBe(true);
    expect(db.crmDeal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: "e-bridges",
          companyId: "c-abbott",
          dealValue: 40000,
          status: "OPEN",
        }),
      }),
    );
  });

  it("requires a name", async () => {
    const res = await createDeal({ ...base, name: "   ", stageId: "s-neg" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NAME_REQUIRED");
  });
});
