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
    crmNotification: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { db } from "@/lib/db";
import { createDeal, updateDeal, moveDealStage, closeDeal } from "@/crm/services/deal-service";

const ORG = "org-1";
const base = { organizationId: ORG, userId: "u-1", source: "rest" as const };

const stage = (
  over: Partial<{ id: string; name: string; isTerminal: boolean; terminalOutcome: "WON" | "LOST" | null }> = {},
) => ({
  id: "s-neg",
  organizationId: ORG,
  name: "Negotiation",
  sortOrder: 3,
  isTerminal: false,
  terminalOutcome: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

/**
 * moveDealStage resolves BOTH ends of the move, so the pipeline-stage findFirst
 * mock must answer per stage id (a single mockResolvedValue would hand the same
 * stage back for from AND to).
 */
function mockStages(byId: Record<string, ReturnType<typeof stage> | null>) {
  vi.mocked(db.crmPipelineStage.findFirst).mockImplementation((async (args: { where?: { id?: string } }) => {
    const id = args?.where?.id;
    return id !== undefined && id in byId ? byId[id] : null;
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({} as never);
});

describe("moveDealStage — the two-people-one-card race", () => {
  it("moves the deal when it is still in the stage the mover saw", async () => {
    mockStages({
      "s-prop": stage({ id: "s-prop", name: "Proposal" }),
      "s-cont": stage({ id: "s-cont", name: "Contacted" }),
    });
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
    mockStages({ "s-prop": stage({ id: "s-prop" }), "s-cont": stage({ id: "s-cont", name: "Contacted" }) });
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
    mockStages({ "s-a": stage({ id: "s-a" }), "s-b": stage({ id: "s-b" }) });
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

  it("dragging into a WON-mapped terminal column closes the deal, stamps wonAt, clears lostReason", async () => {
    // The outcome comes from the stage's terminalOutcome COLUMN — the name is
    // deliberately not "Won" here, pinning that a rename can't break closing (H3).
    mockStages({
      "s-won": stage({ id: "s-won", name: "Deal Signed", isTerminal: true, terminalOutcome: "WON" }),
      "s-neg": stage({ id: "s-neg" }),
    });
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
    // A deal re-won after a lost round must not export a stale "Lost reason" (M10).
    expect(data.lostReason).toBeNull();
  });

  it("dragging between two WON-mapped terminal columns does NOT re-stamp wonAt (CRM review LOW)", async () => {
    // Two terminal columns sharing the WON outcome ("Won — Signed" → "Won —
    // Invoiced"). The deal is already WON; re-stamping wonAt to today would
    // corrupt "won in month X" reports.
    mockStages({
      "s-won1": stage({ id: "s-won1", name: "Won — Signed", isTerminal: true, terminalOutcome: "WON" }),
      "s-won2": stage({ id: "s-won2", name: "Won — Invoiced", isTerminal: true, terminalOutcome: "WON" }),
    });
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", status: "WON", eventId: null } as never);

    await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-won1", toStageId: "s-won2" });

    const data = vi.mocked(db.crmDeal.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.status).toBe("WON"); // status stays WON…
    expect(data).not.toHaveProperty("wonAt"); // …but the close date is preserved, not re-stamped
    expect(data).not.toHaveProperty("lostAt");
  });

  it("dragging back OUT of a terminal column reopens the deal, clears the stamps, and records REOPENED", async () => {
    mockStages({
      "s-neg": stage({ id: "s-neg", isTerminal: false }),
      "s-won": stage({ id: "s-won", name: "Won", isTerminal: true, terminalOutcome: "WON" }),
    });
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", status: "OPEN", eventId: null } as never);

    await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-won", toStageId: "s-neg" });

    const data = vi.mocked(db.crmDeal.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.status).toBe("OPEN");
    // A reopened deal must not linger in a "won in July" report.
    expect(data.wonAt).toBeNull();
    expect(data.lostAt).toBeNull();
    expect(data.lostReason).toBeNull();
    // The close being undone is an explicit trail event, not just a STAGE_MOVE.
    const actions = vi.mocked(db.crmActivity.create).mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);
    expect(actions).toContain("REOPENED");
  });

  it("a move between two ORDINARY columns never touches status — a divergent WON deal is not silently reopened (H3c)", async () => {
    mockStages({
      "s-prop": stage({ id: "s-prop", name: "Proposal" }),
      "s-neg": stage({ id: "s-neg" }),
    });
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", status: "WON", eventId: null } as never);

    await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-neg", toStageId: "s-prop" });

    const data = vi.mocked(db.crmDeal.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    // Only the stage moves. status / wonAt / lostReason are NOT in the payload —
    // the old unconditional `status: "OPEN"` here is how July's won number shrank.
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("wonAt");
    expect(data).not.toHaveProperty("lostReason");
  });

  it("refuses to move an ARCHIVED deal (stale board) with 409 DEAL_ARCHIVED", async () => {
    mockStages({ "s-prop": stage({ id: "s-prop" }), "s-neg": stage({ id: "s-neg" }) });
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 0 } as never); // claim excludes archived
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", stageId: "s-neg", archivedAt: new Date() } as never);

    const res = await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-neg", toStageId: "s-prop" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("DEAL_ARCHIVED");
    // And the claim itself carries the freeze — not just the disambiguation read.
    expect(db.crmDeal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ archivedAt: null }) }),
    );
  });

  it("does NOT invent an outcome for an UNMAPPED terminal stage — status left untouched", async () => {
    // A custom terminal column with no terminalOutcome: never guess "won" from a
    // column name — fictional money in a revenue report. The status is left as-is.
    mockStages({
      "s-arch": stage({ id: "s-arch", name: "Archived", isTerminal: true, terminalOutcome: null }),
      "s-neg": stage({ id: "s-neg" }),
    });
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", eventId: null } as never);

    await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-neg", toStageId: "s-arch" });

    const data = vi.mocked(db.crmDeal.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("wonAt");
  });
});

describe("closeDeal — double-close guard", () => {
  it("closes an OPEN deal as WON, landing it in the WON-mapped column", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue({ id: "s-won" } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({
      id: "d-1", status: "WON", dealValue: 40000, currency: "USD", eventId: "e-1", lostReason: null,
    } as never);

    const res = await closeDeal({ ...base, dealId: "d-1", outcome: "WON" });

    expect(res.ok).toBe(true);
    expect(db.crmDeal.updateMany).toHaveBeenCalledWith(
      // The claim requires status OPEN — this is what stops a double-click
      // re-stamping wonAt and corrupting "deals won in July". archivedAt: null
      // keeps a frozen (archived) deal out of reach too.
      expect.objectContaining({ where: expect.objectContaining({ status: "OPEN", archivedAt: null }) }),
    );
    // The landing column is found by OUTCOME, never by name (H3).
    expect(db.crmPipelineStage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ terminalOutcome: "WON" }) }),
    );
  });

  it("REFUSES to close when the pipeline has no column mapped to the outcome (NO_TERMINAL_STAGE)", async () => {
    // Closing without a landing column would mint a stage/status divergence: the
    // deal counts as open AND as won in the reports — fictional pipeline money.
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(null as never);

    const res = await closeDeal({ ...base, dealId: "d-1", outcome: "WON" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NO_TERMINAL_STAGE");
    expect(db.crmDeal.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to close an ARCHIVED deal with 409 DEAL_ARCHIVED", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue({ id: "s-won" } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", status: "OPEN", archivedAt: new Date() } as never);

    const res = await closeDeal({ ...base, dealId: "d-1", outcome: "WON" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("DEAL_ARCHIVED");
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
    vi.mocked(db.event.findFirst).mockResolvedValue({ id: "e-1" } as never);
    vi.mocked(db.user.findFirst).mockResolvedValue(null as never);

    const res = await createDeal({ ...base, name: "Abbott", stageId: "s-neg", eventId: "e-1", ownerId: "outsider" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("OWNER_NOT_FOUND");
  });

  it("requires an event — a deal must be sold against a project", async () => {
    const res = await createDeal({ ...base, name: "Abbott", stageId: "s-neg", eventId: "" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("EVENT_REQUIRED");
    expect(db.crmDeal.create).not.toHaveBeenCalled();
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

  it("updateDeal refuses to CLEAR the event (re-point yes, remove no)", async () => {
    const res = await updateDeal({ ...base, dealId: "d-1", eventId: null });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("EVENT_REQUIRED");
    expect(db.crmDeal.updateMany).not.toHaveBeenCalled();
  });

  it("R2-M1: updateDeal refuses an ARCHIVED deal — field edits are frozen like stage moves", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({
      name: "Abbott", dealValue: null, currency: "USD", expectedClose: null,
      companyId: null, eventId: "e-1", ownerId: null, archivedAt: new Date(),
    } as never);

    const res = await updateDeal({ ...base, dealId: "d-1", name: "Renamed" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("DEAL_ARCHIVED");
    expect(db.crmDeal.updateMany).not.toHaveBeenCalled();
  });

  it("R2-M1: the write itself re-checks the freeze — an archive landing between snapshot and write loses", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({
      name: "Abbott", dealValue: null, currency: "USD", expectedClose: null,
      companyId: null, eventId: "e-1", ownerId: null, archivedAt: null,
    } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 0 } as never); // archived under us

    const res = await updateDeal({ ...base, dealId: "d-1", name: "Renamed" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("DEAL_ARCHIVED");
    const call = vi.mocked(db.crmDeal.updateMany).mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(call.where).toMatchObject({ archivedAt: null });
  });

  it("R2-M5: rejects an org-bound owner whose ROLE the CRM excludes (the reminder-email side channel)", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(stage() as never);
    vi.mocked(db.event.findFirst).mockResolvedValue({ id: "e-1" } as never);
    vi.mocked(db.user.findFirst).mockResolvedValue({ id: "u-desk", role: "ONSITE" } as never);

    const res = await createDeal({ ...base, name: "Abbott", stageId: "s-neg", eventId: "e-1", ownerId: "u-desk" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("OWNER_ROLE_NOT_ALLOWED");
    expect(db.crmDeal.create).not.toHaveBeenCalled();
  });

  it("requires a name", async () => {
    const res = await createDeal({ ...base, name: "   ", stageId: "s-neg", eventId: "e-1" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NAME_REQUIRED");
  });
});
