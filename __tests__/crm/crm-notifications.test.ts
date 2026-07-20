/**
 * CRM notification service + triggers.
 *
 * Two invariants live in the writer and are pinned here so no call site can
 * regress them:
 *   1. A user is NEVER notified about their own action (actor === recipient).
 *   2. The writer NEVER throws — the mutation it describes already committed,
 *      so an insert blip logs loudly and is swallowed.
 *
 * The trigger tests are EFFECT-level (they assert the db.crmNotification.create
 * payload, not "the notifier was called") — the H4 lesson: a call-shape test
 * passes against a wiring bug.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  db: {
    crmNotification: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    crmDeal: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    crmTask: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    crmPipelineStage: { findFirst: vi.fn() },
    crmCompany: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    crmActivity: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  notifyCrmUser,
  listCrmNotifications,
  markCrmNotificationsRead,
} from "@/crm/lib/crm-notifications";
import { createDeal, updateDeal, moveDealStage, closeDeal } from "@/crm/services/deal-service";
import { createTask, updateTask } from "@/crm/services/task-service";

const ORG = "org-1";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── The writer ────────────────────────────────────────────────────────────────

describe("notifyCrmUser", () => {
  const entry = {
    organizationId: ORG,
    recipientId: "u-owner",
    actorId: "u-actor",
    type: "DEAL_ASSIGNED" as const,
    title: "Deal assigned to you",
    message: 'You are now the owner of "Abbott — Gold"',
    link: "/crm/deals/d-1",
  };

  it("writes the row for a recipient who is not the actor", async () => {
    await notifyCrmUser(entry);

    expect(db.crmNotification.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG,
        userId: "u-owner",
        type: "DEAL_ASSIGNED",
        title: "Deal assigned to you",
        message: 'You are now the owner of "Abbott — Gold"',
        link: "/crm/deals/d-1",
      },
    });
  });

  it("NEVER notifies a user about their own action", async () => {
    await notifyCrmUser({ ...entry, actorId: "u-owner" });
    expect(db.crmNotification.create).not.toHaveBeenCalled();
  });

  it("no-ops silently when there is no recipient", async () => {
    await notifyCrmUser({ ...entry, recipientId: null });
    await notifyCrmUser({ ...entry, recipientId: undefined });
    expect(db.crmNotification.create).not.toHaveBeenCalled();
  });

  it("a null actor (worker / API key) always notifies", async () => {
    await notifyCrmUser({ ...entry, actorId: null });
    expect(db.crmNotification.create).toHaveBeenCalledTimes(1);
  });

  it("never throws — an insert failure logs and is swallowed", async () => {
    vi.mocked(db.crmNotification.create).mockRejectedValueOnce(new Error("pool gone"));

    await expect(notifyCrmUser(entry)).resolves.toBeUndefined();
    expect(apiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "crm-notification:write-failed", type: "DEAL_ASSIGNED" }),
    );
  });
});

// ── Reads / mark-read ─────────────────────────────────────────────────────────

describe("markCrmNotificationsRead", () => {
  it("scopes the write to the caller's own userId + org (no IDOR by construction)", async () => {
    vi.mocked(db.crmNotification.updateMany).mockResolvedValue({ count: 2 } as never);

    const res = await markCrmNotificationsRead({ organizationId: ORG, userId: "u-1", ids: ["n-1", "n-2"] });

    expect(res).toEqual({ count: 2 });
    expect(db.crmNotification.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, userId: "u-1", isRead: false, id: { in: ["n-1", "n-2"] } },
      data: { isRead: true },
    });
  });

  it("mark-all omits the id filter but keeps the user/org scope", async () => {
    vi.mocked(db.crmNotification.updateMany).mockResolvedValue({ count: 5 } as never);

    await markCrmNotificationsRead({ organizationId: ORG, userId: "u-1" });

    expect(db.crmNotification.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, userId: "u-1", isRead: false },
      data: { isRead: true },
    });
  });
});

describe("listCrmNotifications", () => {
  it("caps the page size at 200 no matter what the caller asks for", async () => {
    await listCrmNotifications({ organizationId: ORG, userId: "u-1", limit: 100_000 });

    const args = vi.mocked(db.crmNotification.findMany).mock.calls[0]![0]!;
    expect(args.take).toBe(200);
    expect(args.where).toEqual({ organizationId: ORG, userId: "u-1" });
  });
});

// ── Triggers: deals ───────────────────────────────────────────────────────────

const stageRow = (
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

function mockStages(byId: Record<string, ReturnType<typeof stageRow> | null>) {
  vi.mocked(db.crmPipelineStage.findFirst).mockImplementation((async (args: { where?: { id?: string } }) => {
    const id = args?.where?.id;
    return id !== undefined && id in byId ? byId[id] : null;
  }) as never);
}

/** The single crmNotification.create payload, or null if none was written. */
function writtenNotification(): Record<string, unknown> | null {
  const calls = vi.mocked(db.crmNotification.create).mock.calls;
  if (calls.length === 0) return null;
  return (calls[0]![0] as { data: Record<string, unknown> }).data;
}

describe("deal triggers", () => {
  const base = { organizationId: ORG, userId: "u-actor", source: "rest" as const };

  it("createDeal for someone else → DEAL_ASSIGNED to the owner", async () => {
    mockStages({ "s-neg": stageRow() });
    vi.mocked(db.user.findFirst).mockResolvedValue({ id: "u-owner", role: "CRM_USER" } as never);
    vi.mocked(db.event.findFirst).mockResolvedValue({ id: "e-1" } as never);
    vi.mocked(db.crmDeal.create).mockResolvedValue({
      id: "d-1",
      name: "Abbott — Gold",
      ownerId: "u-owner",
      eventId: "e-1",
    } as never);

    const res = await createDeal({ ...base, name: "Abbott — Gold", stageId: "s-neg", eventId: "e-1", ownerId: "u-owner" });

    expect(res.ok).toBe(true);
    expect(writtenNotification()).toMatchObject({
      userId: "u-owner",
      type: "DEAL_ASSIGNED",
      link: "/crm/deals/d-1",
    });
  });

  it("createDeal owned by the creator themselves → NO notification", async () => {
    mockStages({ "s-neg": stageRow() });
    vi.mocked(db.user.findFirst).mockResolvedValue({ id: "u-actor", role: "CRM_USER" } as never);
    vi.mocked(db.event.findFirst).mockResolvedValue({ id: "e-1" } as never);
    vi.mocked(db.crmDeal.create).mockResolvedValue({
      id: "d-1",
      name: "Abbott — Gold",
      ownerId: "u-actor",
      eventId: "e-1",
    } as never);

    await createDeal({ ...base, name: "Abbott — Gold", stageId: "s-neg", eventId: "e-1", ownerId: "u-actor" });

    expect(db.crmNotification.create).not.toHaveBeenCalled();
  });

  it("updateDeal re-assignment → DEAL_ASSIGNED to the NEW owner only", async () => {
    vi.mocked(db.user.findFirst).mockResolvedValue({ id: "u-new", role: "CRM_USER" } as never);
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({
      name: "Abbott — Gold",
      dealValue: null,
      currency: "USD",
      expectedClose: null,
      companyId: null,
      eventId: "e-1",
      ownerId: "u-old",
    } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", name: "Abbott — Gold" } as never);

    await updateDeal({ ...base, dealId: "d-1", ownerId: "u-new" });

    expect(writtenNotification()).toMatchObject({ userId: "u-new", type: "DEAL_ASSIGNED" });
  });

  it("updateDeal re-sending the UNCHANGED ownerId does not re-nag", async () => {
    vi.mocked(db.user.findFirst).mockResolvedValue({ id: "u-old", role: "CRM_USER" } as never);
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({
      name: "Abbott — Gold",
      dealValue: null,
      currency: "USD",
      expectedClose: null,
      companyId: null,
      eventId: "e-1",
      ownerId: "u-old",
    } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", name: "Abbott — Gold" } as never);

    await updateDeal({ ...base, dealId: "d-1", ownerId: "u-old", name: "Abbott — Gold v2" });

    expect(db.crmNotification.create).not.toHaveBeenCalled();
  });

  it("moveDealStage between open columns → DEAL_STAGE_MOVED to the owner", async () => {
    mockStages({
      "s-prop": stageRow({ id: "s-prop", name: "Proposal" }),
      "s-neg": stageRow({ id: "s-neg", name: "Negotiation" }),
    });
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({
      id: "d-1",
      name: "Abbott — Gold",
      ownerId: "u-owner",
      status: "OPEN",
    } as never);

    await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-prop", toStageId: "s-neg" });

    expect(writtenNotification()).toMatchObject({
      userId: "u-owner",
      type: "DEAL_STAGE_MOVED",
      message: '"Abbott — Gold" moved to Negotiation',
    });
  });

  it("moveDealStage into a WON-mapped terminal column announces DEAL_WON, not a stage move", async () => {
    mockStages({
      "s-neg": stageRow({ id: "s-neg", name: "Negotiation" }),
      "s-won": stageRow({ id: "s-won", name: "Won", isTerminal: true, terminalOutcome: "WON" }),
    });
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({
      id: "d-1",
      name: "Abbott — Gold",
      ownerId: "u-owner",
      status: "WON",
    } as never);

    await moveDealStage({ ...base, dealId: "d-1", fromStageId: "s-neg", toStageId: "s-won" });

    expect(writtenNotification()).toMatchObject({ userId: "u-owner", type: "DEAL_WON" });
  });

  it("closeDeal as LOST → DEAL_LOST to the owner, with no money in the message", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue({ id: "s-lost" } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({
      id: "d-1",
      name: "Abbott — Gold",
      ownerId: "u-owner",
      dealValue: 40000,
      currency: "USD",
      lostReason: "budget cut",
    } as never);

    await closeDeal({ ...base, dealId: "d-1", outcome: "LOST", lostReason: "budget cut" });

    const written = writtenNotification();
    expect(written).toMatchObject({ userId: "u-owner", type: "DEAL_LOST" });
    // The feed is deliberately value-free — money never rides a notification.
    expect(JSON.stringify(written)).not.toContain("40000");
  });

  it("closeDeal by the owner themselves → NO notification", async () => {
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue({ id: "s-won" } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({
      id: "d-1",
      name: "Abbott — Gold",
      ownerId: "u-actor",
      dealValue: null,
      currency: "USD",
      lostReason: null,
    } as never);

    await closeDeal({ ...base, dealId: "d-1", outcome: "WON" });

    expect(db.crmNotification.create).not.toHaveBeenCalled();
  });
});

// ── Triggers: tasks ───────────────────────────────────────────────────────────

describe("task triggers", () => {
  const base = { organizationId: ORG, userId: "u-actor", source: "rest" as const };

  it("createTask assigned to someone else → TASK_ASSIGNED", async () => {
    vi.mocked(db.user.findFirst).mockResolvedValue({ id: "u-owner", role: "CRM_USER" } as never);
    vi.mocked(db.crmTask.create).mockResolvedValue({
      id: "t-1",
      title: "Chase Abbott",
      ownerId: "u-owner",
      dealId: null,
    } as never);

    await createTask({ ...base, title: "Chase Abbott", ownerId: "u-owner" });

    expect(writtenNotification()).toMatchObject({
      userId: "u-owner",
      type: "TASK_ASSIGNED",
      link: "/crm/tasks",
    });
  });

  it("createTask defaulted to the creator (the route's self-assign) → NO notification", async () => {
    vi.mocked(db.user.findFirst).mockResolvedValue({ id: "u-actor", role: "CRM_USER" } as never);
    vi.mocked(db.crmTask.create).mockResolvedValue({
      id: "t-1",
      title: "Chase Abbott",
      ownerId: "u-actor",
      dealId: null,
    } as never);

    await createTask({ ...base, title: "Chase Abbott", ownerId: "u-actor" });

    expect(db.crmNotification.create).not.toHaveBeenCalled();
  });

  it("updateTask re-assignment → TASK_ASSIGNED to the new owner", async () => {
    vi.mocked(db.user.findFirst).mockResolvedValue({ id: "u-new", role: "CRM_USER" } as never);
    vi.mocked(db.crmTask.findFirst).mockResolvedValue({
      title: "Chase Abbott",
      description: null,
      dueAt: null,
      remindAt: null,
      ownerId: "u-old",
    } as never);
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmTask.findUniqueOrThrow).mockResolvedValue({ id: "t-1", title: "Chase Abbott" } as never);

    await updateTask({ ...base, taskId: "t-1", ownerId: "u-new" });

    expect(writtenNotification()).toMatchObject({ userId: "u-new", type: "TASK_ASSIGNED" });
  });

  it("updateTask with the unchanged owner → NO notification", async () => {
    vi.mocked(db.user.findFirst).mockResolvedValue({ id: "u-old", role: "CRM_USER" } as never);
    vi.mocked(db.crmTask.findFirst).mockResolvedValue({
      title: "Chase Abbott",
      description: null,
      dueAt: null,
      remindAt: null,
      ownerId: "u-old",
    } as never);
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmTask.findUniqueOrThrow).mockResolvedValue({ id: "t-1", title: "Chase Abbott" } as never);

    await updateTask({ ...base, taskId: "t-1", ownerId: "u-old", title: "Chase Abbott again" });

    expect(db.crmNotification.create).not.toHaveBeenCalled();
  });
});
