/**
 * CRM reminder worker.
 *
 * The whole job is idempotency, and the ORDER is the design: the row is CLAIMED
 * (remindedAt stamped, conditionally) BEFORE the email is sent.
 *
 * That ordering is a deliberate trade. Claim-then-send means the worst case is a
 * reminder claimed but never delivered — logged loudly, and recoverable by a human
 * looking at an OPEN overdue task. Send-then-claim would make the worst case a
 * reminder emailed twice (or ten times, if a slow send overlaps the next tick).
 * A missed nudge beats an inbox full of duplicate nags.
 *
 * If someone "fixes" this by moving the stamp after the send, these tests fail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { crmTask: { findMany: vi.fn(), updateMany: vi.fn() } },
}));

import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { runTick } from "@/crm/reminders-worker";

const task = (over: Record<string, unknown> = {}) => ({
  id: "t-1",
  title: "Chase Abbott about Gold",
  description: null,
  dueAt: new Date("2026-07-10T00:00:00Z"),
  organizationId: "org-1",
  owner: { id: "u-1", email: "sales@example.com", firstName: "Sam" },
  deal: { id: "d-1", name: "Abbott — BRIDGES 2026 Gold" },
  company: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue({ success: true } as never);
});

describe("runTick", () => {
  it("no-ops when nothing is due", async () => {
    vi.mocked(db.crmTask.findMany).mockResolvedValue([] as never);

    const res = await runTick();

    expect(res).toEqual({ due: 0, sent: 0, skipped: 0, failed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.crmTask.updateMany).not.toHaveBeenCalled();
  });

  it("CLAIMS the row before sending — and the claim is conditional on remindedAt null", async () => {
    vi.mocked(db.crmTask.findMany).mockResolvedValue([task()] as never);
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 1 } as never);

    const order: string[] = [];
    vi.mocked(db.crmTask.updateMany).mockImplementation((() => {
      order.push("claim");
      return Promise.resolve({ count: 1 });
    }) as never);
    vi.mocked(sendEmail).mockImplementation((() => {
      order.push("send");
      return Promise.resolve({ success: true });
    }) as never);

    const res = await runTick();

    // The ordering IS the guarantee.
    expect(order).toEqual(["claim", "send"]);
    expect(res.sent).toBe(1);

    expect(db.crmTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "t-1", remindedAt: null, status: "OPEN" }),
        data: expect.objectContaining({ remindedAt: expect.any(Date) }),
      }),
    );
  });

  it("SKIPS a row another tick already claimed — no second email", async () => {
    // The exact double-send scenario: two workers (or an overlapping tick) both
    // read the row as due. Only one claim can succeed.
    vi.mocked(db.crmTask.findMany).mockResolvedValue([task()] as never);
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 0 } as never); // lost the claim

    const res = await runTick();

    expect(res.skipped).toBe(1);
    expect(res.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does NOT un-claim a row whose send failed", async () => {
    // Un-claiming would re-send on the next tick — and a transient error can fire
    // on a send that actually delivered. Leave it claimed and shout.
    vi.mocked(db.crmTask.findMany).mockResolvedValue([task()] as never);
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(sendEmail).mockRejectedValue(new Error("SES down"));

    const res = await runTick();

    expect(res.failed).toBe(1);
    // Exactly one write: the claim. No rollback.
    expect(db.crmTask.updateMany).toHaveBeenCalledTimes(1);
  });

  it("skips an owner with no email, without un-claiming (else it retries forever)", async () => {
    vi.mocked(db.crmTask.findMany).mockResolvedValue([
      task({ owner: { id: "u-2", email: null, firstName: "Nobody" } }),
    ] as never);
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 1 } as never);

    const res = await runTick();

    expect(res.skipped).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.crmTask.updateMany).toHaveBeenCalledTimes(1); // claimed, not reverted
  });

  it("only picks OPEN, un-reminded, due, owned tasks", async () => {
    vi.mocked(db.crmTask.findMany).mockResolvedValue([] as never);

    await runTick();

    const where = vi.mocked(db.crmTask.findMany).mock.calls[0]![0]!.where as Record<string, unknown>;
    expect(where.status).toBe("OPEN");
    expect(where.remindedAt).toBeNull();
    // A COMPLETED task leaves the queue via `status` alone — which is exactly why
    // completeTask() must never clear remindedAt.
    expect(where.remindAt).toMatchObject({ lte: expect.any(Date) });
    expect(where.ownerId).toMatchObject({ not: null });
  });

  it("escapes the task title in the email body (it is user-authored)", async () => {
    vi.mocked(db.crmTask.findMany).mockResolvedValue([
      task({ title: '<script>alert("x")</script>' }),
    ] as never);
    vi.mocked(db.crmTask.updateMany).mockResolvedValue({ count: 1 } as never);

    await runTick();

    const params = vi.mocked(sendEmail).mock.calls[0]![0]!;
    expect(params.htmlContent).not.toContain("<script>");
    expect(params.htmlContent).toContain("&lt;script&gt;");
  });
});
