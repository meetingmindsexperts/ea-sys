/**
 * Company dedup + task reminder semantics.
 *
 * Two bug classes this codebase has already paid for, pinned here so the CRM
 * doesn't re-buy them:
 *   - contacts H2: a case-sensitive unique index + a writer that didn't normalize
 *     = two rows for one entity, and a downstream sync that mirrors only one.
 *   - the reminder idempotency stamp: clear it at the wrong moment and the worker
 *     re-emails; never clear it and a rescheduled reminder silently never fires.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmCompany: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    crmTask: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    crmDeal: { findFirst: vi.fn() },
    contact: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    crmActivity: { create: vi.fn().mockResolvedValue({}) },
    crmNotification: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { findOrCreateCompany, updateCompany, companyNameKey } from "@/crm/services/company-service";
import { createTask, updateTask, completeTask } from "@/crm/services/task-service";

const ORG = "org-1";
const base = { organizationId: ORG, userId: "u-1", source: "rest" as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(db.crmCompany.findMany).mockResolvedValue([] as never);
  // updateTask now snapshots the row before writing (for the change log), so give
  // the pre-update read a default row.
  vi.mocked(db.crmTask.findFirst).mockResolvedValue({
    id: "t-1", title: "Chase Abbott", description: null, dueAt: null, remindAt: null, ownerId: null,
  } as never);
});

describe("companyNameKey — the dedup key", () => {
  it("normalizes case, surrounding space and internal whitespace", () => {
    // All four of these are the same account. The DB index sees ONE key, so it
    // is structurally impossible to mint a second row for them.
    expect(companyNameKey("Abbott")).toBe("abbott");
    expect(companyNameKey("  ABBOTT  ")).toBe("abbott");
    expect(companyNameKey("abbott")).toBe("abbott");
    expect(companyNameKey("Cleveland   Clinic")).toBe("cleveland clinic");
  });
});

describe("findOrCreateCompany", () => {
  it("REUSES an existing account regardless of the casing you type", async () => {
    const existing = { id: "c-1", name: "Abbott", nameKey: "abbott", needsReview: false };
    vi.mocked(db.crmCompany.findUnique).mockResolvedValue(existing as never);

    const res = await findOrCreateCompany({ ...base, name: "  ABBOTT " });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.created).toBe(false); // reused, not minted
    expect(db.crmCompany.create).not.toHaveBeenCalled();
    // The lookup used the normalized key, not the raw string.
    expect(db.crmCompany.findUnique).toHaveBeenCalledWith({
      where: { organizationId_nameKey: { organizationId: ORG, nameKey: "abbott" } },
    });
  });

  it("creates a new account and stores the normalized key alongside the display name", async () => {
    vi.mocked(db.crmCompany.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.create).mockResolvedValue({ id: "c-2", name: "Abbott", needsReview: false } as never);

    const res = await findOrCreateCompany({ ...base, name: "Abbott" });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.created).toBe(true);
    expect(db.crmCompany.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Abbott", nameKey: "abbott", needsReview: false }),
      }),
    );
  });

  it("FLAGS a near-duplicate for human review but still creates it", async () => {
    // "Cleveland Clinic Foundation" may or may not be the same entity as
    // "Cleveland Clinic". We must not guess — create it, flag it, let a human merge.
    vi.mocked(db.crmCompany.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([{ id: "c-1", name: "Cleveland Clinic" }] as never);
    vi.mocked(db.crmCompany.create).mockResolvedValue({ id: "c-2", needsReview: true } as never);

    const res = await findOrCreateCompany({ ...base, name: "Cleveland Clinic Foundation" });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.created).toBe(true);
    expect(res.needsReview).toBe(true); // advisory — it never blocked the write
    expect(db.crmCompany.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ needsReview: true }) }),
    );
  });

  it("does not flag an unrelated company", async () => {
    vi.mocked(db.crmCompany.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([{ id: "c-1", name: "Cleveland Clinic" }] as never);
    vi.mocked(db.crmCompany.create).mockResolvedValue({ id: "c-9", needsReview: false } as never);

    await findOrCreateCompany({ ...base, name: "Pfizer" });

    expect(db.crmCompany.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ needsReview: false }) }),
    );
  });

  it("requires a name", async () => {
    const res = await findOrCreateCompany({ ...base, name: "   " });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NAME_REQUIRED");
  });
});

describe("updateCompany — rename collision is a 409-class business rejection, not a 500 (H4)", () => {
  it("maps P2002 on the rename to NAME_TAKEN and logs it", async () => {
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue({
      id: "c-1", name: "Cleveland Clinic Foundation", industry: null, website: null,
      country: null, city: null, notes: null, needsReview: false,
    } as never);
    vi.mocked(db.crmCompany.updateMany).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }) as never,
    );

    const res = await updateCompany({
      organizationId: "org-1", userId: "u-1", source: "rest",
      companyId: "c-1", name: "Cleveland Clinic",
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NAME_TAKEN");
    const { apiLogger } = await import("@/lib/logger");
    expect(vi.mocked(apiLogger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "crm-company:update-name-taken" }),
    );
  });
});

describe("task reminder stamp", () => {
  it("re-arming a reminder CLEARS remindedAt, so the new time actually fires", async () => {
    // Without this, moving a reminder to a new time would never fire: the worker
    // skips any row whose remindedAt is already set. Changing WHEN you want to be
    // reminded must actually change when you are reminded.
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmTask.findUniqueOrThrow).mockResolvedValue({ id: "t-1" } as never);

    await updateTask({ ...base, taskId: "t-1", remindAt: new Date("2026-08-01T09:00:00Z") });

    const data = vi.mocked(db.crmTask.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.remindAt).toBeInstanceOf(Date);
    expect(data.remindedAt).toBeNull();
  });

  it("moving the DUE date moves a due-date-armed reminder with it (M12)", async () => {
    // The only create surface arms remindAt = dueAt ("email me when it's due").
    const due = new Date("2026-08-01T00:00:00Z");
    vi.mocked(db.crmTask.findFirst).mockResolvedValue({
      id: "t-1", title: "Chase Abbott", description: null, dueAt: due, remindAt: due, ownerId: null,
    } as never);
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmTask.findUniqueOrThrow).mockResolvedValue({ id: "t-1" } as never);

    const newDue = new Date("2026-08-08T00:00:00Z");
    await updateTask({ ...base, taskId: "t-1", dueAt: newDue });

    const data = vi.mocked(db.crmTask.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    // The reminder follows the due date and is re-armed — otherwise "you'll get
    // an email when it's due" silently breaks on the first reschedule.
    expect(data.remindAt).toEqual(newDue);
    expect(data.remindedAt).toBeNull();
  });

  it("a due-date move leaves an INDEPENDENTLY-set reminder alone", async () => {
    vi.mocked(db.crmTask.findFirst).mockResolvedValue({
      id: "t-1", title: "Chase Abbott", description: null,
      dueAt: new Date("2026-08-01T00:00:00Z"), remindAt: new Date("2026-07-25T00:00:00Z"), ownerId: null,
    } as never);
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmTask.findUniqueOrThrow).mockResolvedValue({ id: "t-1" } as never);

    await updateTask({ ...base, taskId: "t-1", dueAt: new Date("2026-08-08T00:00:00Z") });

    const data = vi.mocked(db.crmTask.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("remindAt");
    expect(data).not.toHaveProperty("remindedAt");
  });

  it("the History diff is computed from the SUBMITTED patch, never a post-write re-read (M4)", async () => {
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 1 } as never);
    // Simulate a concurrent writer landing between our write and the re-read:
    // the re-read shows THEIR title. The activity diff must still record OURS.
    vi.mocked(db.crmTask.findUniqueOrThrow).mockResolvedValue({
      id: "t-1", title: "SOMEONE ELSES EDIT",
    } as never);

    await updateTask({ ...base, taskId: "t-1", title: "Chase Abbott (mine)" });

    const activity = vi.mocked(db.crmActivity.create).mock.calls[0]![0] as unknown as {
      data: { changes: { changes: Record<string, { from: unknown; to: unknown }> } };
    };
    expect(activity.data.changes.changes.title).toEqual({
      from: "Chase Abbott",
      to: "Chase Abbott (mine)", // ← the patch, not the racy re-read
    });
  });

  it("an unrelated edit does NOT clear remindedAt (that would re-send the email)", async () => {
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmTask.findUniqueOrThrow).mockResolvedValue({ id: "t-1" } as never);

    await updateTask({ ...base, taskId: "t-1", title: "Chase Abbott (renamed)" });

    const data = vi.mocked(db.crmTask.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("remindedAt");
  });

  it("completing a task does NOT touch remindedAt — status=DONE drops it from the queue", async () => {
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmTask.findUniqueOrThrow).mockResolvedValue({ id: "t-1", dealId: null } as never);

    await completeTask({ ...base, taskId: "t-1" });

    const call = vi.mocked(db.crmTask.updateMany).mock.calls[0]![0]!;
    const data = call.data as Record<string, unknown>;
    expect(data.status).toBe("DONE");
    expect(data).not.toHaveProperty("remindedAt");
    // Conditional claim: a double-clicked "Done" must not re-stamp completedAt.
    expect(call.where).toMatchObject({ status: "OPEN" });
  });

  it("409s ALREADY_DONE on a double-complete instead of re-stamping completedAt", async () => {
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(db.crmTask.findFirst).mockResolvedValue({ id: "t-1", status: "DONE" } as never);

    const res = await completeTask({ ...base, taskId: "t-1" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("ALREADY_DONE");
  });
});


// ── R2 batch pins ───────────────────────────────────────────────────────────────

describe("R2-M1 — archived records are frozen for FIELD edits too", () => {
  it("updateCompany refuses an archived account", async () => {
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue({
      name: "Abbott", industry: null, website: null, country: null, city: null,
      notes: null, needsReview: false, archivedAt: new Date(),
    } as never);

    const res = await updateCompany({ ...base, companyId: "c-1", name: "Renamed" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("COMPANY_ARCHIVED");
    expect(db.crmCompany.updateMany).not.toHaveBeenCalled();
  });

  it("updateTask refuses an archived task — it could otherwise re-arm a dormant reminder", async () => {
    vi.mocked(db.crmTask.findFirst).mockResolvedValue({
      title: "Chase", description: null, dueAt: null, remindAt: null, ownerId: null,
      archivedAt: new Date(),
    } as never);

    const res = await updateTask({ ...base, taskId: "t-1", remindAt: new Date() });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("TASK_ARCHIVED");
    expect(db.crmTask.updateMany).not.toHaveBeenCalled();
  });
});

describe("R2-M5 — a task assignee must be a CRM-capable role", () => {
  it("rejects a MEMBER assignee (prose-blind; the reminder email would hand them the deal prose)", async () => {
    vi.mocked(db.user.findFirst).mockResolvedValue({ id: "u-member", role: "MEMBER" } as never);

    const res = await createTask({ ...base, title: "Chase Abbott", ownerId: "u-member" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("OWNER_ROLE_NOT_ALLOWED");
    expect(db.crmTask.create).not.toHaveBeenCalled();
  });
});

describe("R2 rider L12 — a due date arms the reminder IN THE SERVICE", () => {
  it("createTask with only dueAt defaults remindAt = dueAt (raw API callers get the same contract as the UI)", async () => {
    const due = new Date("2026-08-01T09:00:00Z");
    vi.mocked(db.crmTask.create).mockResolvedValue({ id: "t-1", title: "Chase", ownerId: null, dealId: null } as never);

    const res = await createTask({ ...base, title: "Chase", dueAt: due });

    expect(res.ok).toBe(true);
    const data = vi.mocked(db.crmTask.create).mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.remindAt).toEqual(due);
  });

  it("an EXPLICIT remindAt: null means no reminder — the default never overrides a choice", async () => {
    vi.mocked(db.crmTask.create).mockResolvedValue({ id: "t-1", title: "Chase", ownerId: null, dealId: null } as never);

    const res = await createTask({ ...base, title: "Chase", dueAt: new Date(), remindAt: null });

    expect(res.ok).toBe(true);
    const data = vi.mocked(db.crmTask.create).mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.remindAt).toBeNull();
  });
});
