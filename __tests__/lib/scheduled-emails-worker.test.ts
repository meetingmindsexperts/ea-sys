/**
 * Pins the scheduled-emails worker's recipientIds passthrough — the
 * reason ScheduledEmail gained a recipientIds column (2026-06-09). A
 * queued row with explicit recipient ids must forward them to
 * executeBulkEmail (so "send to selected" survives the queue); an empty
 * array must forward `undefined` (so executeBulkEmail falls back to the
 * filter-based recipient resolution, which keys off recipientIds?.length).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockExecuteBulkEmail, mockNotify, mockLogger, BulkEmailError, NO_RECIPIENTS_CODE } =
  vi.hoisted(() => {
    // Genuine error shape so the worker's
    // `err instanceof BulkEmailError && err.code === NO_RECIPIENTS_CODE`
    // branch resolves correctly; only executeBulkEmail is stubbed.
    class BulkEmailError extends Error {
      status: number;
      code?: string;
      constructor(message: string, status = 400, code?: string) {
        super(message);
        this.status = status;
        this.code = code;
      }
    }
    return {
      mockDb: {
        scheduledEmail: { updateMany: vi.fn(), findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
        user: { findMany: vi.fn() },
        auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
      },
      mockExecuteBulkEmail: vi.fn(),
      mockNotify: vi.fn().mockReturnValue({ catch: () => {} }),
      mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      BulkEmailError,
      NO_RECIPIENTS_CODE: "NO_RECIPIENTS" as const,
    };
  });

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: mockNotify }));
vi.mock("@/lib/bulk-email", () => ({
  executeBulkEmail: mockExecuteBulkEmail,
  BulkEmailError,
  NO_RECIPIENTS_CODE,
}));

import { runScheduledEmailsTick } from "@/lib/scheduled-emails-worker";
import { MAX_STORED_ERRORS, parseFailedRecipients } from "@/lib/scheduled-email-failures";

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "se_1",
    eventId: "ev_1",
    organizationId: "org_1",
    createdById: "user_1",
    recipientType: "registrations",
    emailType: "custom",
    customSubject: "Hi",
    customMessage: "Body",
    attachments: null,
    filters: null,
    recipientIds: [],
    emailedKeys: [],
    retryCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // sweep updateMany → 0 stuck; subsequent claim updateMany → 1 (we own it)
  mockDb.scheduledEmail.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
  mockDb.scheduledEmail.update.mockResolvedValue({});
  mockDb.user.findMany.mockResolvedValue([
    { id: "user_1", firstName: "Ana", lastName: "Org", email: "ana@x.com", emailSignature: null },
  ]);
  mockExecuteBulkEmail.mockResolvedValue({ total: 2, successCount: 2, failureCount: 0, errors: [] });
});

describe("scheduled-emails worker — recipientIds passthrough", () => {
  it("forwards explicit recipientIds to executeBulkEmail (send-to-selected survives the queue)", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      dueRow({ recipientIds: ["r1", "r2"] }),
    ]);

    const report = await runScheduledEmailsTick();

    expect(report.processed).toBe(1);
    expect(mockExecuteBulkEmail).toHaveBeenCalledTimes(1);
    expect(mockExecuteBulkEmail.mock.calls[0][0]).toMatchObject({
      recipientIds: ["r1", "r2"],
    });
  });

  it("forwards undefined when recipientIds is empty (filter-based send)", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ recipientIds: [] })]);

    await runScheduledEmailsTick();

    expect(mockExecuteBulkEmail).toHaveBeenCalledTimes(1);
    expect(mockExecuteBulkEmail.mock.calls[0][0].recipientIds).toBeUndefined();
  });

  it("marks the row SENT via a conditional (status=PROCESSING) completion claim", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ recipientIds: ["r1"] })]);

    await runScheduledEmailsTick();

    // Completion is a conditional updateMany — only writes if we still own the
    // row: status=PROCESSING AND our claimToken (review M1 + C1: a superseded
    // zombie must not clobber a reclaimed row; status alone matches a row a
    // retry re-claimed, the token cannot).
    expect(mockDb.scheduledEmail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "se_1", status: "PROCESSING", claimToken: expect.any(String) },
        data: expect.objectContaining({ status: "SENT", successCount: 2, totalCount: 2 }),
      }),
    );
  });

  it("C1: the claim stamps a fresh ownership token; completion conditions on the SAME token", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ recipientIds: ["r1"] })]);

    await runScheduledEmailsTick();

    // Call order: [0] sweep, [1] claim, [2] completion.
    const claimCall = mockDb.scheduledEmail.updateMany.mock.calls[1][0];
    expect(claimCall.where).toEqual({ id: "se_1", status: "PENDING" });
    expect(claimCall.data.status).toBe("PROCESSING");
    const stamped = claimCall.data.claimToken;
    expect(typeof stamped).toBe("string");
    expect(stamped.length).toBeGreaterThan(10);

    const completionCall = mockDb.scheduledEmail.updateMany.mock.calls[2][0];
    expect(completionCall.where.claimToken).toBe(stamped);
  });

  it("does NOT clobber or re-notify when the completion claim is superseded", async () => {
    // sweep→0, claim→1 (we own it), completion→0 (row was swept + reclaimed).
    mockDb.scheduledEmail.updateMany.mockReset();
    mockDb.scheduledEmail.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 });
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ recipientIds: ["r1"] })]);

    const report = await runScheduledEmailsTick();

    // Emails still went out, so the row is reported sent…
    expect(report.results[0]).toMatchObject({ id: "se_1", status: "sent" });
    // …but we must NOT re-fire the admin notification / audit for a row we no
    // longer own, and we log the supersede.
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "scheduled-email:completion-superseded", id: "se_1" }),
    );
  });

  it("includes retryCount in the scheduled-email:sent log line", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ retryCount: 2, recipientIds: ["r1"] })]);

    await runScheduledEmailsTick();

    const sentLog = mockLogger.info.mock.calls.find(
      (c: unknown[]) => (c[0] as { msg?: string })?.msg === "scheduled-email:sent",
    );
    expect(sentLog?.[0]).toMatchObject({ retryCount: 2 });
  });
});

describe("scheduled-emails worker — empty audience is a benign skip", () => {
  it("marks a 0-recipient send SENT with zero counts (not FAILED) and logs info, not error", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      dueRow({ emailType: "webinar-thank-you", customSubject: null, customMessage: null }),
    ]);
    mockExecuteBulkEmail.mockRejectedValueOnce(
      new BulkEmailError("No recipients found matching the criteria", 400, NO_RECIPIENTS_CODE),
    );

    const report = await runScheduledEmailsTick();

    // Reported as a skip, not a failure.
    expect(report.failed).toBe(0);
    expect(report.results[0]).toMatchObject({ id: "se_1", status: "skipped", total: 0 });

    // Row flipped to terminal SENT with zeroed counts and no error text, via
    // the conditional (status=PROCESSING) write.
    expect(mockDb.scheduledEmail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "se_1", status: "PROCESSING", claimToken: expect.any(String) },
        data: expect.objectContaining({
          status: "SENT",
          totalCount: 0,
          successCount: 0,
          failureCount: 0,
          lastError: null,
        }),
      }),
    );

    // Logged at info (no admin-alert page), and NOT at error.
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "scheduled-email:skipped-no-recipients", id: "se_1" }),
    );
    const failLog = mockLogger.error.mock.calls.find(
      (c: unknown[]) => (c[0] as { msg?: string })?.msg === "scheduled-email:send-failed",
    );
    expect(failLog).toBeUndefined();
  });

  it("still marks a genuine send error FAILED and logs error", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ recipientIds: ["r1"] })]);
    mockExecuteBulkEmail.mockRejectedValueOnce(new Error("SES throttled"));

    const report = await runScheduledEmailsTick();

    expect(report.failed).toBe(1);
    expect(mockDb.scheduledEmail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "se_1", status: "PROCESSING", claimToken: expect.any(String) },
        data: expect.objectContaining({ status: "FAILED", lastError: "SES throttled" }),
      }),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "scheduled-email:send-failed", id: "se_1" }),
    );
  });
});

describe("scheduled-emails worker — mid-send cancel / lost ownership (C1 + C5)", () => {
  it("passes a shouldContinue check through to executeBulkEmail", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ recipientIds: ["r1"] })]);

    await runScheduledEmailsTick();

    const input = mockExecuteBulkEmail.mock.calls[0][0];
    expect(typeof input.shouldContinue).toBe("function");
  });

  it("an aborted send writes NO terminal status, fires no audit/notify, and logs the abort", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ recipientIds: ["r1"] })]);
    // Cancelled mid-flight: 25 of 30 went out before the stop.
    mockExecuteBulkEmail.mockResolvedValue({
      total: 30,
      successCount: 25,
      failureCount: 0,
      aborted: true,
      errors: [],
    });

    const report = await runScheduledEmailsTick();

    expect(report.results[0]).toMatchObject({ id: "se_1", status: "skipped", sent: 25 });
    // No SENT/FAILED write FOR OUR ROW — whoever owns the row (the cancel, a
    // re-claim) owns its terminal state. (The tick-level stuck-sweep also
    // writes FAILED, but with a row-less where — exclude it by id.)
    const terminalWrite = mockDb.scheduledEmail.updateMany.mock.calls.find(
      (c: unknown[]) => {
        const call = c[0] as { where?: { id?: string }; data?: { status?: string } };
        const status = call?.data?.status;
        return call?.where?.id === "se_1" && (status === "SENT" || status === "FAILED");
      },
    );
    expect(terminalWrite).toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "scheduled-email:send-aborted", id: "se_1", sentBeforeAbort: 25 }),
    );
  });

  it("the worker's shouldContinue returns true only while the row is PROCESSING with OUR token", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ recipientIds: ["r1"] })]);
    const findUnique = mockDb.scheduledEmail.findUnique;

    await runScheduledEmailsTick();

    const claimCall = mockDb.scheduledEmail.updateMany.mock.calls[1][0];
    const ourToken = claimCall.data.claimToken as string;
    const shouldContinue = mockExecuteBulkEmail.mock.calls[0][0].shouldContinue as () => Promise<boolean>;

    // Still ours → keep going.
    findUnique.mockResolvedValueOnce({ status: "PROCESSING", claimToken: ourToken });
    await expect(shouldContinue()).resolves.toBe(true);
    // Cancelled mid-send → stop.
    findUnique.mockResolvedValueOnce({ status: "CANCELLED", claimToken: ourToken });
    await expect(shouldContinue()).resolves.toBe(false);
    // Swept + re-claimed by a retry (different token) → stand down (C1).
    findUnique.mockResolvedValueOnce({ status: "PROCESSING", claimToken: "someone-else" });
    await expect(shouldContinue()).resolves.toBe(false);
  });
});

describe("scheduled-emails worker — partial-failure recipient list", () => {
  it("stores the full (capped) failed-recipient list in lastError; failureCount is the true total", async () => {
    const errors = Array.from({ length: MAX_STORED_ERRORS + 50 }, (_, i) => ({
      email: `u${i}@x.com`,
      error: "hard bounce",
    }));
    mockExecuteBulkEmail.mockResolvedValue({
      total: errors.length + 10,
      successCount: 10,
      failureCount: errors.length,
      errors,
    });
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ recipientIds: ["r1"] })]);

    await runScheduledEmailsTick();

    const sentCall = mockDb.scheduledEmail.updateMany.mock.calls.find(
      (c: unknown[]) => (c[0] as { data?: { status?: string } })?.data?.status === "SENT",
    );
    expect(sentCall).toBeTruthy();
    const data = (sentCall![0] as { data: { failureCount: number; lastError: string } }).data;
    // True total preserved even though the stored list is capped.
    expect(data.failureCount).toBe(errors.length);
    const stored = parseFailedRecipients(data.lastError);
    expect(stored).toHaveLength(MAX_STORED_ERRORS);
    expect(stored![0]).toEqual({ email: "u0@x.com", error: "hard bounce" });
  });

  it("stores no lastError when there were zero failures", async () => {
    mockExecuteBulkEmail.mockResolvedValue({ total: 3, successCount: 3, failureCount: 0, errors: [] });
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ recipientIds: ["r1"] })]);

    await runScheduledEmailsTick();

    const sentCall = mockDb.scheduledEmail.updateMany.mock.calls.find(
      (c: unknown[]) => (c[0] as { data?: { status?: string } })?.data?.status === "SENT",
    );
    expect((sentCall![0] as { data: { lastError: string | null } }).data.lastError).toBeNull();
  });
});
