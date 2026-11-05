import { createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import { access, mkdir, rename } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * webinar-presence-archive — retention for the webinar page heartbeats (security review, Nov 5,
 * 2026, W-06).
 *
 * `WebinarPresence` says when a named registrant opened the webinar page, when it was last open,
 * lobby or watching, and how often they rejoined. The live reader is the console's "here now"
 * roster, which looks back 60 seconds; the durable "Joined" fact is
 * `Registration.webinarFirstJoinedAt`, and CME attendance comes from Zoom's report.
 *
 * Owner, Nov 5, 2026: 90 days live (nothing reads an older row; the question it answers, "was
 * this person in the lobby?", comes up in the days after a webinar), then archive, never delete
 * outright. Rows not seen for 90 days are written to `logs/archive/webinar-presence/webinar-presence-<run date>.jsonl.gz` (the same
 * mounted volume and gzip-JSONL shape as the SystemLog archive), and only the rows that landed in
 * that file are removed from the table: temp file, rename, then delete by id.
 *
 * Self-healing: a missed run catches up on the next one; a crash before the rename leaves the rows
 * in place for the next run.
 */

export const WEBINAR_PRESENCE_RETENTION_DAYS = 90;

/** Rows per run; a bigger backlog continues the next night and says so. */
const MAX_ROWS_PER_TICK = 20_000;
const PAGE = 1000;

/** Overridable for tests; defaults to the mounted logs volume. */
export function getPresenceArchiveDir(): string {
  return (
    process.env.WEBINAR_PRESENCE_ARCHIVE_DIR ||
    path.join(process.cwd(), "logs", "archive", "webinar-presence")
  );
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** A name no earlier run used: two runs on one day get -2, -3, ... */
async function freshPath(dir: string, day: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `webinar-presence-${day}.jsonl.gz` : `webinar-presence-${day}-${n}.jsonl.gz`;
    const full = path.join(dir, name);
    if (!(await exists(full)) && !(await exists(`${full}.tmp`))) return full;
  }
}

export async function runWebinarPresenceArchiveTick(now: Date = new Date()): Promise<{
  archived: number;
  file: string | null;
  capped: boolean;
}> {
  const cutoff = new Date(now.getTime() - WEBINAR_PRESENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const rows: Record<string, unknown>[] = [];
  let cursorId: string | undefined;
  while (rows.length < MAX_ROWS_PER_TICK) {
    const page = await db.webinarPresence.findMany({
      where: { lastSeenAt: { lt: cutoff } },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });
    rows.push(...page);
    if (page.length < PAGE) break;
    cursorId = page[page.length - 1].id;
  }
  if (rows.length === 0) return { archived: 0, file: null, capped: false };
  const capped = rows.length >= MAX_ROWS_PER_TICK;

  const dir = getPresenceArchiveDir();
  await mkdir(dir, { recursive: true });
  const finalPath = await freshPath(dir, now.toISOString().slice(0, 10));
  const tmpPath = `${finalPath}.tmp`;
  await pipeline(
    Readable.from(rows.map((r) => JSON.stringify(r) + "\n")),
    createGzip(),
    createWriteStream(tmpPath),
  );
  await rename(tmpPath, finalPath);

  // Only what is now in the file leaves the table.
  const ids = rows.map((r) => r.id as string);
  let archived = 0;
  for (let i = 0; i < ids.length; i += PAGE) {
    const res = await db.webinarPresence.deleteMany({ where: { id: { in: ids.slice(i, i + PAGE) } } });
    archived += res.count;
  }

  const log = { archived, file: path.basename(finalPath), cutoff: cutoff.toISOString(), capped };
  if (capped) apiLogger.warn(log, "webinar-presence-archive:capped");
  else apiLogger.info(log, "webinar-presence-archive:done");
  return { archived, file: path.basename(finalPath), capped };
}
