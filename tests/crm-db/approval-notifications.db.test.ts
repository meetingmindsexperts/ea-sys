/**
 * The approval-escalation tick on a REAL Postgres. Its idempotency is nothing
 * but the conditional claims it makes before every email, and a mocked Prisma
 * has one fake connection, so two ticks racing each other cannot be shown
 * there. Here two ticks start together and each email goes out once, the next
 * tier's step opens once, and the nested reads (a step's request, a decided
 * request's deciding step) are real queries rather than a mock's promise.
 *
 * The email transport is the only thing mocked: nothing here may reach SES.
 *
 * Run: docker compose --profile crm-test up -d
 *      CRM_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:crm-db
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: (...a: unknown[]) => mockSend(...a) }));
vi.mock("@/lib/module-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/module-flags")>()),
  isProcurementModuleEnabled: () => true,
}));

import { db } from "@/lib/db";
import { runApprovalNotificationsTick } from "@/lib/approvals/approval-notifications-worker";
import { resetCrm } from "./helper";

const H = 3_600_000;

interface Seed {
  orgId: string;
  requesterId: string;
  linaId: string;
  medhatId: string;
}

async function seed(): Promise<Seed> {
  const { orgId, userId: requesterId } = await resetCrm();
  const lina = await db.user.create({
    data: { organizationId: orgId, email: "lina@test.local", passwordHash: "x", firstName: "Lina", lastName: "H", role: "ADMIN", procurementApproveCeilingAed: 1_000_000 },
    select: { id: true },
  });
  const medhat = await db.user.create({
    data: { organizationId: orgId, email: "medhat@test.local", passwordHash: "x", firstName: "Medhat", lastName: "F", role: "SUPER_ADMIN", procurementApproveUnlimited: true },
    select: { id: true },
  });
  return { orgId, requesterId, linaId: lina.id, medhatId: medhat.id };
}

async function pendingRequest(s: Seed, now: Date, o: { ageHours: number; notified: boolean; remindedHoursAgo?: number }) {
  const createdAt = new Date(now.getTime() - o.ageHours * H);
  return db.approvalRequest.create({
    data: {
      organizationId: s.orgId,
      subjectType: "BUDGET",
      subjectId: "budget-that-is-not-seeded",
      amountAed: 500_000,
      requesterUserId: s.requesterId,
      createdAt,
      steps: {
        create: {
          organizationId: s.orgId,
          sequence: 1,
          assigneeUserId: s.linaId,
          createdAt,
          dueAt: new Date(createdAt.getTime() + 24 * H),
          notifiedAt: o.notified ? createdAt : null,
          remindedAt: o.remindedHoursAgo === undefined ? null : new Date(now.getTime() - o.remindedHoursAgo * H),
        },
      },
    },
    select: { id: true },
  });
}

const recipients = () => mockSend.mock.calls.map((c) => (c[0] as { to: { email: string }[] }).to[0].email);

let s: Seed;
beforeEach(async () => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ success: true });
  s = await seed();
});

describe("approval-escalation on a real database", () => {
  it("two ticks started together send the assignment email once", async () => {
    const now = new Date();
    const r = await pendingRequest(s, now, { ageHours: 0.1, notified: false });
    await Promise.all([runApprovalNotificationsTick(now), runApprovalNotificationsTick(now)]);
    expect(recipients()).toEqual(["lina@test.local"]);
    const step = await db.approvalStep.findFirstOrThrow({ where: { requestId: r.id } });
    expect(step.notifiedAt?.getTime()).toBe(now.getTime());
  });

  it("a reminder fires once, and a later tick does not repeat it", async () => {
    const now = new Date();
    await pendingRequest(s, now, { ageHours: 25, notified: true });
    await runApprovalNotificationsTick(now);
    await runApprovalNotificationsTick(new Date(now.getTime() + 5 * 60_000));
    expect(recipients()).toEqual(["lina@test.local"]);
  });

  it("a 97-hour step is escalated exactly once under two concurrent ticks", async () => {
    const now = new Date();
    const r = await pendingRequest(s, now, { ageHours: 97, notified: true, remindedHoursAgo: 73 });
    await Promise.all([runApprovalNotificationsTick(now), runApprovalNotificationsTick(now)]);

    const steps = await db.approvalStep.findMany({ where: { requestId: r.id }, orderBy: { sequence: "asc" } });
    expect(steps.map((x) => [x.sequence, x.status, x.assigneeUserId])).toEqual([
      [1, "SKIPPED", s.linaId],
      [2, "PENDING", s.medhatId],
    ]);
    expect(steps[0].escalatedAt).not.toBeNull();
    expect(steps[1].notifiedAt).not.toBeNull();
    expect(recipients()).toEqual(["medhat@test.local"]);
    expect(await db.auditLog.count({ where: { organizationId: s.orgId, action: "APPROVAL_ESCALATED", entityId: r.id } })).toBe(1);

    // And the new step is not immediately escalated or re-mailed by the next tick.
    mockSend.mockClear();
    await runApprovalNotificationsTick(new Date(now.getTime() + 5 * 60_000));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("a decision is emailed to the requester once, naming the decider from the deciding step", async () => {
    const now = new Date();
    const decidedAt = new Date(now.getTime() - H);
    await db.approvalRequest.create({
      data: {
        organizationId: s.orgId,
        subjectType: "BUDGET",
        subjectId: "budget-that-is-not-seeded",
        amountAed: 500_000,
        requesterUserId: s.requesterId,
        status: "APPROVED",
        decidedAt,
        steps: {
          create: [
            { organizationId: s.orgId, sequence: 1, assigneeUserId: s.medhatId, dueAt: now, status: "SKIPPED" },
            { organizationId: s.orgId, sequence: 2, assigneeUserId: s.linaId, dueAt: now, status: "APPROVED", decidedByUserId: s.linaId, decidedAt, note: "Go ahead" },
          ],
        },
      },
    });
    await Promise.all([runApprovalNotificationsTick(now), runApprovalNotificationsTick(now)]);
    const requester = await db.user.findUniqueOrThrow({ where: { id: s.requesterId }, select: { email: true } });
    expect(recipients()).toEqual([requester.email]);
    const text = (mockSend.mock.calls[0][0] as { textContent: string }).textContent;
    expect(text).toContain("Lina H approved your budget.");
    expect(text).toContain("Note: Go ahead");
  });

  it("a step on a cancelled request is never touched", async () => {
    const now = new Date();
    const r = await pendingRequest(s, now, { ageHours: 97, notified: true, remindedHoursAgo: 73 });
    await db.approvalRequest.update({ where: { id: r.id }, data: { status: "CANCELLED", decidedAt: now } });
    await runApprovalNotificationsTick(now);
    expect(await db.approvalStep.count({ where: { requestId: r.id } })).toBe(1);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
