import { readdir, stat, unlink } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { storageProvider } from "@/lib/storage";
import { SUPPORTING_DOCUMENT_PATH_PREFIX } from "@/lib/supporting-document";

/**
 * resident-letter-prune — removes official-letter uploads no registration ever
 * claimed.
 *
 * The upload endpoint is public and unauthenticated, and it necessarily writes
 * the file BEFORE the registration exists (the form uploads, then submits). So
 * every abandoned form leaves a file behind, as does every "Replace" click. The
 * upload's own limits bound how fast that can grow (5MB, 10/hr/IP), but nothing
 * bounds the TOTAL, and disk on the box is not free — so something has to
 * collect them.
 *
 * ── The two properties that matter ──────────────────────────────────────────
 *
 * 1. A file is only ever deleted if NO registration references it. The check is
 *    a DB lookup per file, not an inference from its age or location.
 *
 * 2. Nothing younger than the grace period is touched, EVEN IF unreferenced.
 *    That window is the whole safety margin: between the upload landing and the
 *    registration committing there is a period — the registrant still filling
 *    in billing details, a Stripe redirect, a slow form — where the file is
 *    legitimately orphaned. Deleting during it would silently destroy a letter
 *    the registrant successfully attached.
 *
 * Unlike the row-pruning jobs beside it this deletes FILES, so it walks the
 * directory rather than querying a table. Failures are per-file and logged: one
 * unreadable directory must not stop the sweep.
 */

/** Nothing younger than this is considered abandoned. See property 2 above. */
export const RESIDENT_LETTER_GRACE_HOURS = 24;

/** Per-tick ceiling so a large backlog can't hold the worker slot for minutes. */
const MAX_DELETES_PER_TICK = 500;

export interface ResidentLetterPruneResult {
  scanned: number;
  deleted: number;
  /** Unreferenced but inside the grace window — left alone deliberately. */
  skippedRecent: number;
  /** Hit the per-tick ceiling; the rest are collected on the next run. */
  capped: boolean;
  errors: number;
}

export async function runSupportingDocumentPruneTick(
  now: Date = new Date(),
): Promise<ResidentLetterPruneResult> {
  const root = path.resolve(process.cwd(), "public", SUPPORTING_DOCUMENT_PATH_PREFIX.slice(1));
  const cutoff = now.getTime() - RESIDENT_LETTER_GRACE_HOURS * 60 * 60 * 1000;

  const result: ResidentLetterPruneResult = {
    scanned: 0,
    deleted: 0,
    skippedRecent: 0,
    capped: false,
    errors: 0,
  };

  // This is the ONE file operation not yet routed through storage.ts, because
  // it walks directories and storage.ts has no listing primitive yet. See
  // docs/UAE_DOCUMENT_RESIDENCY_PLAN.md Phase 2.
  //
  // The guard matters more than the gap. Under a non-local provider the walk
  // below would readdir an empty local directory, find no orphans, and report a
  // clean tick forever while unclaimed uploads accumulated untouched. That is a
  // silent failure, and the difference between an outage you can see and one
  // you cannot. Logging at error means it reaches the admin alert and the daily
  // digest on the very first tick after a provider change.
  if (storageProvider !== "local") {
    apiLogger.error({
      msg: "resident-letter-prune:unsupported-provider",
      provider: storageProvider,
      detail:
        "The prune walk is filesystem-only. It cannot see files under this provider and has pruned NOTHING. Needs a storage listing primitive before the provider switch.",
    });
    result.errors++;
    return result;
  }

  let eventDirs: string[];
  try {
    eventDirs = await readdir(root);
  } catch {
    // No directory yet — no event has taken a resident registration with a
    // letter. Nothing to do, and not a failure.
    return result;
  }

  for (const eventDir of eventDirs) {
    if (result.deleted >= MAX_DELETES_PER_TICK) {
      result.capped = true;
      break;
    }

    const dirAbs = path.join(root, eventDir);
    let files: string[];
    try {
      files = await readdir(dirAbs);
    } catch (err) {
      result.errors++;
      apiLogger.warn({ err, msg: "resident-letter-prune:readdir-failed", eventDir });
      continue;
    }

    for (const file of files) {
      if (result.deleted >= MAX_DELETES_PER_TICK) {
        result.capped = true;
        break;
      }
      result.scanned++;

      const abs = path.join(dirAbs, file);
      const url = `${SUPPORTING_DOCUMENT_PATH_PREFIX}${eventDir}/${file}`;

      try {
        const info = await stat(abs);
        if (info.mtimeMs >= cutoff) {
          result.skippedRecent++;
          continue;
        }

        // The claim check. Deliberately AFTER the age check so a busy event
        // does not cost one query per recent file every night.
        const claimed = await db.registration.findFirst({
          where: { supportingDocumentUrl: url },
          select: { id: true },
        });
        if (claimed) continue;

        await unlink(abs);
        result.deleted++;
      } catch (err) {
        result.errors++;
        apiLogger.warn({ err, msg: "resident-letter-prune:file-failed", url });
      }
    }
  }

  if (result.deleted > 0 || result.capped || result.errors > 0) {
    apiLogger.info({ msg: "resident-letter-prune:tick", ...result });
  }
  return result;
}
