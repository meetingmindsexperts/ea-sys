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
import { randomUUID } from "node:crypto";
import { createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, link, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * `systemlog-2026-05.jsonl.gz`, or `systemlog-2026-05-2.jsonl.gz` for a second file of the same month
 * (an archive is never overwritten): the only file shapes we accept (traversal-safe).
 */
export const ARCHIVE_FILE_RE = /^systemlog-(\d{4})-(\d{2})(?:-(\d{1,2}))?\.jsonl\.gz$/;
const BATCH = 5000;
/** Rows deleted per statement: a month after a log flood can be hundreds of thousands (review of d1ce3eca). */
const DELETE_BATCH = 1000;
/** Files one month may have before the run gives up and says so. */
const MAX_FILES_PER_MONTH = 99;

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

/**
 * Give the finished temp file its archive name without ever replacing one: `link` fails when the
 * name is taken, so a month archived before (rows that came back, or a manual run beside the
 * monthly one) gets `-2`, `-3`... and the earlier file, and its copy in the DR bucket, stay whole
 * (review of d1ce3eca: a rename replaced it, and the nightly sync would have copied the smaller
 * file over the bucket's). Returns the name used.
 */
async function claimArchiveName(dir: string, key: string, tmpPath: string): Promise<string> {
  for (let n = 1; n <= MAX_FILES_PER_MONTH; n++) {
    const name = n === 1 ? `systemlog-${key}.jsonl.gz` : `systemlog-${key}-${n}.jsonl.gz`;
    try {
      await link(tmpPath, path.join(dir, name));
      await unlink(tmpPath);
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`log-archive: ${MAX_FILES_PER_MONTH} files already exist for ${key}`);
}

/** Delete one month's rows a thousand at a time, so no single statement holds a month of WAL. */
async function deleteMonth(start: Date, end: Date): Promise<number> {
  let deleted = 0;
  for (;;) {
    const batch = await db.systemLog.findMany({
      where: { timestamp: { gte: start, lt: end } },
      select: { id: true },
      take: DELETE_BATCH,
    });
    if (batch.length === 0) return deleted;
    const del = await db.systemLog.deleteMany({ where: { id: { in: batch.map((r) => r.id) } } });
    deleted += del.count;
    if (batch.length < DELETE_BATCH) return deleted;
  }
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
 * safely re-written (its own temp file, then a name that never replaces an earlier archive;
 * rows are deleted only after the file lands).
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
    // A temp file of this run's own: two runs at once (the monthly job and a manual one) never write
    // into the same file (review of d1ce3eca). Not matched by ARCHIVE_FILE_RE, so never listed.
    const tmpPath = path.join(dir, `.systemlog-${key}.${randomUUID()}.tmp`);

    // Write the whole month to a temp gzip, then give it its name: a crash mid-write never leaves
    // a truncated archive in place, and rows are deleted only once the file is safely on disk.
    await pipeline(Readable.from(monthLines(start, end)), createGzip(), createWriteStream(tmpPath));
    const file = await claimArchiveName(dir, key, tmpPath);

    const rows = await deleteMonth(start, end);
    totalRows += rows;
    archivedMonths.push(key);
    apiLogger.info({
      msg: "log-archive:month-archived",
      month: key,
      file,
      rows,
      // A month archived before: its earlier file is kept and this one is numbered beside it.
      existed: file !== `systemlog-${key}.jsonl.gz`,
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
  out.sort((a, b) => b.month.localeCompare(a.month) || b.name.localeCompare(a.name, undefined, { numeric: true }));
  return out;
}
