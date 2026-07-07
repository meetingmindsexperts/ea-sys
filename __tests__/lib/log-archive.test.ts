/**
 * SystemLog monthly archival — the cutoff rule (July → archive May & below), the
 * path-traversal guard, and a real end-to-end run: an in-memory SystemLog is
 * archived to real gzip files in a temp dir, then gunzipped back and verified.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { gunzipSync } from "node:zlib";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface Row { id: string; timestamp: Date; level: number; module: string; message: string }
const store: { rows: Row[] } = { rows: [] };

/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock("@/lib/db", () => ({
  db: {
    systemLog: {
      findFirst: vi.fn(async (args: any) => {
        const cutoff = args.where.timestamp.lt as Date;
        const older = store.rows
          .filter((r) => r.timestamp < cutoff)
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        return older[0] ? { timestamp: older[0].timestamp } : null;
      }),
      findMany: vi.fn(async (args: any) => {
        const { gte, lt } = args.where.timestamp;
        let list = store.rows
          .filter((r) => r.timestamp >= gte && r.timestamp < lt)
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id));
        if (args.cursor) list = list.slice(list.findIndex((r) => r.id === args.cursor.id) + 1);
        return list.slice(0, args.take);
      }),
      deleteMany: vi.fn(async (args: any) => {
        const { gte, lt } = args.where.timestamp;
        const before = store.rows.length;
        store.rows = store.rows.filter((r) => !(r.timestamp >= gte && r.timestamp < lt));
        return { count: before - store.rows.length };
      }),
    },
  },
}));
/* eslint-enable @typescript-eslint/no-explicit-any */
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { archiveCutoff, resolveArchivePath, runLogArchiveTick, getArchiveDir } from "@/lib/log-archive";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "logarch-"));
  process.env.LOG_ARCHIVE_DIR = tmpDir;
  store.rows = [];
});
afterAll(() => { delete process.env.LOG_ARCHIVE_DIR; });

function row(id: string, iso: string): Row {
  return { id, timestamp: new Date(iso), level: 30, module: "api", message: `log ${id}` };
}
function readArchive(month: string): Row[] {
  const buf = readFileSync(path.join(tmpDir, `systemlog-${month}.jsonl.gz`));
  return gunzipSync(buf).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("archiveCutoff", () => {
  it("July → first of June (keeps June + July live, archives May & below)", () => {
    expect(archiveCutoff(new Date("2026-07-15T12:00:00Z")).toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
  it("January → first of the previous December (year boundary)", () => {
    expect(archiveCutoff(new Date("2026-01-10T00:00:00Z")).toISOString()).toBe("2025-12-01T00:00:00.000Z");
  });
});

describe("resolveArchivePath (traversal guard)", () => {
  it("accepts a well-formed archive name", () => {
    expect(resolveArchivePath("systemlog-2026-05.jsonl.gz")).toBe(path.join(getArchiveDir(), "systemlog-2026-05.jsonl.gz"));
  });
  it("rejects traversal / malformed names", () => {
    expect(resolveArchivePath("../../etc/passwd")).toBeNull();
    expect(resolveArchivePath("systemlog-2026-5.jsonl.gz")).toBeNull(); // month not 2 digits
    expect(resolveArchivePath("systemlog-2026-05.jsonl")).toBeNull(); // not gz
    expect(resolveArchivePath("evil.gz")).toBeNull();
    expect(resolveArchivePath("systemlog-2026-05.jsonl.gz/../x")).toBeNull();
  });
});

describe("runLogArchiveTick", () => {
  it("archives each month below the cutoff to its own gz file and deletes those rows", async () => {
    store.rows = [
      row("a", "2026-04-05T09:00:00Z"),            // April → archive
      row("b", "2026-05-10T09:00:00Z"),            // May → archive
      row("c", "2026-05-20T18:00:00Z"),            // May → archive
      row("d", "2026-06-10T09:00:00Z"),            // June → live
      row("e", "2026-07-01T09:00:00Z"),            // July → live
    ];

    const result = await runLogArchiveTick(new Date("2026-07-15T00:00:00Z"));

    // oldest month first
    expect(result.archivedMonths).toEqual(["2026-04", "2026-05"]);
    expect(result.totalRows).toBe(3);
    // June + July rows remain live
    expect(store.rows.map((r) => r.id).sort()).toEqual(["d", "e"]);
    // files written + contents round-trip
    expect(readArchive("2026-04").map((r) => r.id)).toEqual(["a"]);
    expect(readArchive("2026-05").map((r) => r.id)).toEqual(["b", "c"]);
    expect(existsSync(path.join(tmpDir, "systemlog-2026-06.jsonl.gz"))).toBe(false);
  });

  it("is a no-op when nothing is older than the cutoff", async () => {
    store.rows = [row("x", "2026-07-02T09:00:00Z"), row("y", "2026-06-02T09:00:00Z")];
    const result = await runLogArchiveTick(new Date("2026-07-15T00:00:00Z"));
    expect(result.archivedMonths).toEqual([]);
    expect(result.totalRows).toBe(0);
    expect(store.rows).toHaveLength(2);
  });
});
