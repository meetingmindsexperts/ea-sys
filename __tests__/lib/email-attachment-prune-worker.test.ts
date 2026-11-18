/**
 * email-attachment-prune (src/lib/email-attachment-prune-worker.ts).
 *
 * The two guards that matter: a file a queued send still references is NEVER
 * deleted whatever its age, and a file inside the grace window is never
 * deleted whatever its references. If the reference set cannot be read the
 * tick deletes nothing (fail closed).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { listStoredFiles, deleteStoredFile, findMany, tenantFindMany, sees } = vi.hoisted(() => ({
  listStoredFiles: vi.fn(),
  deleteStoredFile: vi.fn(async () => undefined),
  findMany: vi.fn(),
  // The tenant client. The job must never ask it: with no lane it sees nothing.
  tenantFindMany: vi.fn(),
  sees: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({ listStoredFiles, deleteStoredFile }));
// The reference set is read on the privileged client (the job has no tenant lane).
// A DIFFERENT object from `db`, so a job that went back to `db` fails here.
vi.mock("@/lib/db", () => ({
  db: { scheduledEmail: { findMany: tenantFindMany } },
  dbOperator: { scheduledEmail: { findMany } },
  operatorSeesEveryTenant: (t: string) => sees(t),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { runEmailAttachmentPruneTick, EMAIL_ATTACHMENT_GRACE_DAYS } from "@/lib/email-attachment-prune-worker";

const NOW = new Date("2026-09-08T05:15:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const file = (storedPath: string, ageDays: number) => ({ storedPath, modifiedAt: daysAgo(ageDays), sizeBytes: 10 });

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  sees.mockResolvedValue(true);
});

describe("the privileged client", () => {
  it("deletes NOTHING when it cannot see every organisation's queued sends", async () => {
    // Row security on and DATABASE_URL_OPERATOR forgotten: the reference set
    // would be empty and every file would go (review of 2a05830e).
    sees.mockResolvedValue(false);
    listStoredFiles.mockResolvedValueOnce([file("/uploads/email-attachments/ev1/old.pdf", EMAIL_ATTACHMENT_GRACE_DAYS + 1)]);
    const r = await runEmailAttachmentPruneTick(NOW);
    expect(sees).toHaveBeenCalledWith("ScheduledEmail");
    expect(deleteStoredFile).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deleted: 0, errors: 1 });
  });

  it("is the one asked, never the tenant client", async () => {
    listStoredFiles.mockResolvedValueOnce([file("/uploads/email-attachments/ev1/old.pdf", EMAIL_ATTACHMENT_GRACE_DAYS + 1)]);
    await runEmailAttachmentPruneTick(NOW);
    expect(findMany).toHaveBeenCalled();
    expect(tenantFindMany).not.toHaveBeenCalled();
  });
});

describe("runEmailAttachmentPruneTick", () => {
  it("deletes an old unreferenced file, keeps a recent one and a referenced one", async () => {
    listStoredFiles.mockResolvedValueOnce([
      file("/uploads/email-attachments/ev1/old.pdf", EMAIL_ATTACHMENT_GRACE_DAYS + 1),
      file("/uploads/email-attachments/ev1/recent.pdf", 1),
      file("/uploads/email-attachments/ev1/queued.pdf", 30),
    ]);
    findMany.mockResolvedValueOnce([
      { attachments: [{ storedPath: "/uploads/email-attachments/ev1/queued.pdf", name: "q.pdf", contentType: "application/pdf" }] },
    ]);
    const r = await runEmailAttachmentPruneTick(NOW);
    expect(r).toMatchObject({ scanned: 3, deleted: 1, skippedRecent: 1, skippedReferenced: 1, capped: false, errors: 0 });
    expect(deleteStoredFile).toHaveBeenCalledTimes(1);
    expect(deleteStoredFile).toHaveBeenCalledWith("/uploads/email-attachments/ev1/old.pdf", "/uploads/email-attachments/");
    // Only sends that can still fire hold a reference.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ["PENDING", "PROCESSING", "FAILED"] } } }),
    );
  });

  it("deletes nothing when the reference set cannot be read (fail closed)", async () => {
    listStoredFiles.mockResolvedValueOnce([file("/uploads/email-attachments/ev1/old.pdf", 30)]);
    findMany.mockRejectedValueOnce(new Error("db down"));
    const r = await runEmailAttachmentPruneTick(NOW);
    expect(r.deleted).toBe(0);
    expect(r.errors).toBe(1);
    expect(deleteStoredFile).not.toHaveBeenCalled();
  });

  it("a listing failure is reported, not swallowed", async () => {
    listStoredFiles.mockRejectedValueOnce(new Error("s3 down"));
    const r = await runEmailAttachmentPruneTick(NOW);
    expect(r).toMatchObject({ scanned: 0, deleted: 0, errors: 1 });
  });

  it("the job module is wired with a unique id and the documented cadence", async () => {
    const { JOB_NAME, JOB_ID, SCHEDULE } = await import("../../worker/jobs/email-attachment-prune");
    expect(JOB_NAME).toBe("email-attachment-prune");
    expect(JOB_ID).toBe(1019);
    expect(SCHEDULE).toBe("15 5 * * *");
  });
});
