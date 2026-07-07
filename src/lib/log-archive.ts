/**
 * Monthly SystemLog archival — keeps the live `/logs` (SystemLog) table bounded
 * while retaining every log inside the system as compressed monthly files.
 *
 * Rule: keep the CURRENT + PREVIOUS calendar month live; archive everything
 * older into one gzip-JSONL file per month, then delete those rows from the hot
 * table. Example: run in JULY → archive MAY and every earlier month (June + July
 * stay live). Each older month becomes its own `systemlog-YYYY-MM.jsonl.gz`
 * under `logs/archive/` (the shared, mounted logs volume) and is downloadable by
 * a SUPER_ADMIN from `/logs`.
 *
 * Server-only (Node fs/zlib + Prisma). Driven monthly by the worker; also
 * runnable on demand via `POST /api/logs/archive`.
 */
import { createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, rename, access } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/** `systemlog-2026-05.jsonl.gz` — the only file shape we accept (traversal-safe). */
export const ARCHIVE_FILE_RE = /^systemlog-(\d{4})-(\d{2})\.jsonl\.gz$/;
const BATCH = 5000;

/** Overridable for tests; defaults to the mounted logs volume. */
export function getArchiveDir(): string {
  return process.env.LOG_ARCHIVE_DIR || path.join(process.cwd(), "logs", "archive");
}

/**
 * The cutoff: rows with `timestamp < archiveCutoff(now)` are archived. It's the
 * first day (UTC) of the PREVIOUS month, so the current + previous month stay
 * live. July → June 1 → archives May and everything before.
 */
export function archiveCutoff(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function nextMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** Resolve a caller-supplied archive filename to an absolute path, or null if it
 *  doesn't match the strict pattern / escapes the archive dir (path-traversal). */
export function resolveArchivePath(name: string): string | null {
  if (!ARCHIVE_FILE_RE.test(name)) return null;
  const dir = getArchiveDir();
  const full = path.join(dir, name);
  if (path.dirname(full) !== dir) return null; // defense in depth
  return full;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Stream one month's rows as JSONL lines, cursor-paginated so memory stays flat. */
async function* monthLines(start: Date, end: Date): AsyncGenerator<string> {
  let cursorId: string | undefined;
  for (;;) {
    const rows = await db.systemLog.findMany({
      where: { timestamp: { gte: start, lt: end } },
      orderBy: [{ timestamp: "asc" }, { id: "asc" }],
      take: BATCH,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });
    if (rows.length === 0) return;
    for (const r of rows) yield JSON.stringify(r) + "\n";
    cursorId = rows[rows.length - 1].id;
    if (rows.length < BATCH) return;
  }
}

export interface LogArchiveResult {
  archivedMonths: string[];
  totalRows: number;
}

/**
 * Archive every full month older than the cutoff. Idempotent: a re-run finds no
 * rows for an already-archived month and skips it; a partially-written month is
 * safely re-written (temp file + rename, delete only after the file lands).
 */
export async function runLogArchiveTick(now: Date = new Date()): Promise<LogArchiveResult> {
  const cutoff = archiveCutoff(now);
  const dir = getArchiveDir();
  await mkdir(dir, { recursive: true });

  const archivedMonths: string[] = [];
  let totalRows = 0;

  // Walk from the oldest archivable row forward, one month per iteration.
  for (;;) {
    const oldest = await db.systemLog.findFirst({
      where: { timestamp: { lt: cutoff } },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true },
    });
    if (!oldest) break;

    const start = monthStart(oldest.timestamp);
    const end = nextMonthStart(oldest.timestamp);
    const key = monthKey(oldest.timestamp);
    const finalPath = path.join(dir, `systemlog-${key}.jsonl.gz`);
    const tmpPath = `${finalPath}.tmp`;

    // Write the whole month to a temp gzip, then atomically rename — so a crash
    // mid-write never leaves a truncated archive in place, and we only delete
    // rows once the file is safely on disk.
    await pipeline(Readable.from(monthLines(start, end)), createGzip(), createWriteStream(tmpPath));
    await rename(tmpPath, finalPath);

    const del = await db.systemLog.deleteMany({ where: { timestamp: { gte: start, lt: end } } });
    totalRows += del.count;
    archivedMonths.push(key);
    apiLogger.info({
      msg: "log-archive:month-archived",
      month: key,
      file: path.basename(finalPath),
      rows: del.count,
      existed: await exists(finalPath),
    });
  }

  apiLogger.info({
    msg: archivedMonths.length ? "log-archive:done" : "log-archive:nothing-to-archive",
    cutoff: cutoff.toISOString(),
    archivedMonths,
    totalRows,
  });
  return { archivedMonths, totalRows };
}

export interface ArchiveListing {
  name: string;
  month: string;
  sizeBytes: number;
  modifiedAt: string;
}

/** List the archive files (newest month first). Empty when nothing archived yet. */
export async function listArchives(): Promise<ArchiveListing[]> {
  const dir = getArchiveDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: ArchiveListing[] = [];
  for (const name of names) {
    const m = ARCHIVE_FILE_RE.exec(name);
    if (!m) continue;
    const s = await stat(path.join(dir, name));
    out.push({ name, month: `${m[1]}-${m[2]}`, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() });
  }
  out.sort((a, b) => b.month.localeCompare(a.month));
  return out;
}
