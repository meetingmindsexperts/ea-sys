/**
 * Webinar presence retention (security review W-06; owner, Nov 5, 2026: 90 days, then archive,
 * never delete outright). Rows not seen for 90 days go to a gzip JSONL file first; only the rows
 * in that file leave the table.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { webinarPresence: { findMany: vi.fn(), deleteMany: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { runWebinarPresenceArchiveTick, WEBINAR_PRESENCE_RETENTION_DAYS } from "@/lib/webinar/presence-archive-worker";

const NOW = new Date("2026-11-05T04:20:00Z");
const rows = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${String(from + i).padStart(6, "0")}`, registrationId: `r${i}`, phase: "joined" }));

let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(path.join(tmpdir(), "presence-archive-"));
  process.env.WEBINAR_PRESENCE_ARCHIVE_DIR = dir;
  mockDb.webinarPresence.deleteMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => ({
    count: where.id.in.length,
  }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.WEBINAR_PRESENCE_ARCHIVE_DIR;
});

const archived = (file: string) =>
  gunzipSync(readFileSync(path.join(dir, file))).toString().trim().split("\n").map((l) => JSON.parse(l));

describe("runWebinarPresenceArchiveTick", () => {
  it("keeps 90 days: only rows not seen for 90 days are read", async () => {
    expect(WEBINAR_PRESENCE_RETENTION_DAYS).toBe(90);
    mockDb.webinarPresence.findMany.mockResolvedValueOnce([]);
    await runWebinarPresenceArchiveTick(NOW);
    const cutoff = new Date(NOW.getTime() - 90 * 86_400_000);
    expect(mockDb.webinarPresence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lastSeenAt: { lt: cutoff } } }),
    );
  });

  it("writes the rows to a gzip file first, then removes exactly those ids", async () => {
    mockDb.webinarPresence.findMany.mockResolvedValueOnce(rows(3));
    const r = await runWebinarPresenceArchiveTick(NOW);
    expect(r).toEqual({ archived: 3, file: "webinar-presence-2026-11-05.jsonl.gz", capped: false });
    expect(archived(r.file!).map((x) => x.id)).toEqual(["p000000", "p000001", "p000002"]);
    // Still past the cutoff at delete time: a heartbeat in between keeps its row (review L1).
    const cutoff = new Date(NOW.getTime() - 90 * 86_400_000);
    expect(mockDb.webinarPresence.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["p000000", "p000001", "p000002"] }, lastSeenAt: { lt: cutoff } },
    });
  });

  it("nothing old enough: no file, nothing removed", async () => {
    mockDb.webinarPresence.findMany.mockResolvedValueOnce([]);
    expect(await runWebinarPresenceArchiveTick(NOW)).toEqual({ archived: 0, file: null, capped: false });
    expect(readdirSync(dir)).toEqual([]);
    expect(mockDb.webinarPresence.deleteMany).not.toHaveBeenCalled();
  });

  it("if the file cannot be written, nothing is removed", async () => {
    process.env.WEBINAR_PRESENCE_ARCHIVE_DIR = "/dev/null/cannot-exist";
    mockDb.webinarPresence.findMany.mockResolvedValueOnce(rows(2));
    await expect(runWebinarPresenceArchiveTick(NOW)).rejects.toThrow();
    expect(mockDb.webinarPresence.deleteMany).not.toHaveBeenCalled();
  });

  it("a second run the same day never overwrites the first file", async () => {
    mockDb.webinarPresence.findMany.mockResolvedValueOnce(rows(1));
    await runWebinarPresenceArchiveTick(NOW);
    mockDb.webinarPresence.findMany.mockResolvedValueOnce(rows(1, 50));
    const r = await runWebinarPresenceArchiveTick(NOW);
    expect(r.file).toBe("webinar-presence-2026-11-05-2.jsonl.gz");
    expect(readdirSync(dir).sort()).toEqual(["webinar-presence-2026-11-05-2.jsonl.gz", "webinar-presence-2026-11-05.jsonl.gz"]);
  });

  it("a backlog bigger than one run is capped and says so; the rest waits for the next night", async () => {
    let n = 0;
    mockDb.webinarPresence.findMany.mockImplementation(async () => rows(1000, (n++) * 1000));
    const r = await runWebinarPresenceArchiveTick(NOW);
    expect(r).toMatchObject({ archived: 20_000, capped: true });
    expect(archived(r.file!)).toHaveLength(20_000);
  });
});
