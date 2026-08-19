/**
 * resident-letter-prune — the two properties that make it safe to run.
 *
 * This job deletes FILES on a production box, so the tests below are the whole
 * argument that it will not delete the wrong one:
 *
 *   1. A referenced file is never deleted, however old.
 *   2. An unreferenced file inside the grace window is never deleted either.
 *      That window covers the gap between the upload landing and the
 *      registration committing — a registrant still filling in billing details
 *      has a legitimately orphaned file, and deleting it would destroy a letter
 *      they successfully attached.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockList, mockDelete } = vi.hoisted(() => ({
  mockDb: { registration: { findFirst: vi.fn() } },
  mockList: vi.fn(),
  mockDelete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
// Mocked at the STORAGE boundary rather than at fs, because enumeration moved
// behind listStoredFiles so this job works under any backing store. What is
// under test here is the age gate, the claim check and the per-tick cap, not
// how bytes are enumerated — storage.test.ts covers that separately.
vi.mock("@/lib/storage", () => ({
  listStoredFiles: mockList,
  deleteStoredFile: mockDelete,
}));

const NOW = new Date("2026-08-12T12:00:00Z");
const OLD = NOW.getTime() - 48 * 60 * 60 * 1000; // 2 days — outside the window
const RECENT = NOW.getTime() - 2 * 60 * 60 * 1000; // 2 hours — inside it

/** One event directory holding the given files, all outside the grace window. */
function layout(files: string[], mtimeMs: number = OLD) {
  mockList.mockResolvedValue(
    files.map((f) => ({
      storedPath: `/uploads/resident-letters/evt1/${f}`,
      modifiedAt: new Date(mtimeMs),
      sizeBytes: 1234,
    })),
  );
}

describe("runSupportingDocumentPruneTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue(undefined);
    mockList.mockResolvedValue([]);
    mockDb.registration.findFirst.mockResolvedValue(null);
  });

  async function run() {
    const { runSupportingDocumentPruneTick } = await import("@/lib/supporting-document-prune-worker");
    return runSupportingDocumentPruneTick(NOW);
  }

  it("deletes an old file no registration references", async () => {
    layout(["abandoned.pdf"]);
    const res = await run();
    expect(res.deleted).toBe(1);
    expect(mockDelete).toHaveBeenCalledOnce();
  });

  it("NEVER deletes a file a registration references", async () => {
    layout(["claimed.pdf"]);
    mockDb.registration.findFirst.mockResolvedValue({ id: "reg1" });
    const res = await run();
    expect(res.deleted).toBe(0);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("looks the file up by the URL shape the register POST stores", async () => {
    // If these two disagreed, every letter would look unreferenced and the job
    // would delete live ones. The lookup value is the assertion.
    layout(["8be760f8-935f.pdf"]);
    await run();
    expect(mockDb.registration.findFirst).toHaveBeenCalledWith({
      where: { supportingDocumentUrl: "/uploads/resident-letters/evt1/8be760f8-935f.pdf" },
      select: { id: true },
    });
  });

  it("NEVER deletes an unreferenced file inside the grace window", async () => {
    // The safety margin: this is a form that is still being filled in.
    layout(["in-flight.pdf"], RECENT);
    const res = await run();
    expect(res.deleted).toBe(0);
    expect(res.skippedRecent).toBe(1);
    expect(mockDelete).not.toHaveBeenCalled();
    // And it does not even ask the database about a file it cannot delete.
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("is a clean no-op when nothing has been uploaded yet", async () => {
    mockList.mockResolvedValue([]);
    const res = await run();
    expect(res).toMatchObject({ scanned: 0, deleted: 0, errors: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("keeps sweeping when one file fails", async () => {
    // One unreadable file must not strand the rest of the backlog.
    layout(["bad.pdf", "good.pdf"]);
    mockDb.registration.findFirst.mockImplementation(async (args: { where: { supportingDocumentUrl: string } }) => {
      if (args.where.supportingDocumentUrl.endsWith("bad.pdf")) throw new Error("EACCES");
      return null;
    });
    const res = await run();
    expect(res.errors).toBe(1);
    expect(res.deleted).toBe(1);
  });

  it("reports when it hits the per-tick ceiling instead of capping silently", async () => {
    layout(Array.from({ length: 600 }, (_, i) => `f${i}.pdf`));
    const res = await run();
    expect(res.deleted).toBe(500);
    expect(res.capped).toBe(true);
  });
});

describe("worker roster", () => {
  it("is registered, so the digest's under-run check can see it", async () => {
    // The drift guard: a job that runs but is absent from EXPECTED_JOBS is
    // invisible to the daily digest's expected-vs-actual comparison.
    const { EXPECTED_JOB_NAMES } = await import("@/lib/worker-jobs");
    const { JOB_NAME, JOB_ID } = await import("../../worker/jobs/supporting-document-prune");
    const { JOB_IDS } = await import("../../worker/lib/job-ids");
    expect(EXPECTED_JOB_NAMES.has(JOB_NAME)).toBe(true);
    expect(JOB_ID).toBe(JOB_IDS.RESIDENT_LETTER_PRUNE);
    // Advisory-lock ids must be unique or two jobs would exclude each other.
    const ids = Object.values(JOB_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
