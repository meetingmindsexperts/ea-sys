/**
 * email-attachment-prune (src/lib/email-attachment-prune-worker.ts).
 *
 * The two guards that matter: a file a queued send still references is NEVER
 * deleted whatever its age, and a file inside the grace window is never
 * deleted whatever its references. If the reference set cannot be read the
 * tick deletes nothing (fail closed).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { listStoredFiles, deleteStoredFile, findMany } = vi.hoisted(() => ({
  listStoredFiles: vi.fn(),
  deleteStoredFile: vi.fn(async () => undefined),
  findMany: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({ listStoredFiles, deleteStoredFile }));
vi.mock("@/lib/db", () => ({ db: { scheduledEmail: { findMany } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { runEmailAttachmentPruneTick, EMAIL_ATTACHMENT_GRACE_DAYS } from "@/lib/email-attachment-prune-worker";

const NOW = new Date("2026-09-08T05:15:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const file = (storedPath: string, ageDays: number) => ({ storedPath, modifiedAt: daysAgo(ageDays), sizeBytes: 10 });

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
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
