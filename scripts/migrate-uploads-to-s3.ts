/**
 * Phase 3 of docs/UAE_DOCUMENT_RESIDENCY_PLAN.md — copy every local upload into
 * the S3 bucket.
 *
 *   docker exec ea-sys-worker npx tsx scripts/migrate-uploads-to-s3.ts            # dry run
 *   docker exec ea-sys-worker npx tsx scripts/migrate-uploads-to-s3.ts --write
 *   docker exec ea-sys-worker npx tsx scripts/migrate-uploads-to-s3.ts --verify   # compare only
 *
 * Runs inside the worker container so it uses the same runtime, the same
 * instance role and the same env as production, rather than a hand-built local
 * environment that might differ.
 *
 * ## Properties
 *
 * **Idempotent.** Re-running copies nothing that is already present with the
 * same size. Safe to run repeatedly during the bake period.
 *
 * **Writes nothing to the database.** Stored paths are unchanged by design: the
 * S3 key is the stored path minus `/uploads/`, so every value already persisted
 * keeps resolving. If this script needed a database write, the plan would be
 * wrong.
 *
 * **Does not delete anything, ever.** Not from local disk, not from S3. Removing
 * the local copies is a separate, later, deliberate act once the bake period has
 * proven the bucket. A migration that deletes as it goes has no rollback.
 *
 * **Verifies by size, not just by presence.** A truncated copy is worse than a
 * missing one, because a missing file is loud and a truncated one renders as a
 * broken image forever.
 */
import { config } from "dotenv";
import path from "path";

config({ path: path.resolve(process.cwd(), ".env") });
config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const WRITE = process.argv.includes("--write");
const VERIFY_ONLY = process.argv.includes("--verify");

/** Every segment that holds uploads. Kept explicit so a new one is a decision. */
const SEGMENTS = [
  "photos",
  "media",
  "agreements",
  "certificates",
  "stripe-receipts",
  "speaker-docs",
  "reimbursements",
  "crm-deal-docs",
  "crm-email-attachments",
  "resident-letters",
] as const;

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  html: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
};

function mimeFor(storedPath: string): string {
  const ext = (storedPath.split(".").pop() ?? "").toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

async function main() {
  const bucket = process.env.S3_UPLOADS_BUCKET;
  if (!bucket) {
    console.error("S3_UPLOADS_BUCKET is not set. Run Phase 0 first (plan section 5).");
    process.exit(1);
  }

  // Read the LOCAL side through the filesystem directly rather than through
  // storage.ts, because STORAGE_PROVIDER may already be "s3" when this runs
  // during cutover, and then listStoredFiles would enumerate the destination
  // and the migration would compare the bucket against itself.
  const { readdir, stat, readFile } = await import("fs/promises");
  const { join, resolve, sep } = await import("path");
  const { s3Upload, s3List } = await import("../src/lib/storage-s3");

  let copied = 0;
  let skipped = 0;
  let mismatched = 0;
  let failed = 0;
  let totalBytes = 0;

  for (const segment of SEGMENTS) {
    const root = resolve(process.cwd(), "public", "uploads", segment);

    const local: { key: string; abs: string; size: number }[] = [];
    async function walk(dir: string): Promise<void> {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return; // segment never used on this box
      }
      for (const entry of entries) {
        const abs = join(dir, entry);
        const info = await stat(abs).catch(() => null);
        if (!info) continue;
        if (info.isDirectory()) {
          await walk(abs);
          continue;
        }
        const rel = abs.slice(root.length + 1).split(sep).join("/");
        local.push({ key: `${segment}/${rel}`, abs, size: info.size });
      }
    }
    await walk(root);

    if (local.length === 0) {
      console.log(`  ${segment.padEnd(22)} (no local files)`);
      continue;
    }

    // One listing per segment, so the per-file check is a map lookup rather
    // than a HeadObject round trip each. At ~500 files that is the difference
    // between one call and five hundred.
    const remote = new Map<string, number>();
    for (const obj of await s3List(`${segment}/`)) {
      remote.set(obj.key, obj.sizeBytes);
    }

    let segCopied = 0;
    let segSkipped = 0;
    for (const file of local) {
      const existing = remote.get(file.key);
      if (existing !== undefined) {
        if (existing === file.size) {
          segSkipped++;
          skipped++;
          continue;
        }
        // Present but a different size: a previous run was interrupted
        // mid-object. Re-copy rather than trust it.
        mismatched++;
        console.warn(`    size mismatch, re-copying: ${file.key} (local ${file.size}, remote ${existing})`);
      }

      if (!WRITE || VERIFY_ONLY) {
        segCopied++;
        copied++;
        totalBytes += file.size;
        continue;
      }

      try {
        const buf = await readFile(file.abs);
        await s3Upload(buf, file.key, mimeFor(file.key));
        segCopied++;
        copied++;
        totalBytes += file.size;
      } catch (err) {
        failed++;
        console.error(`    FAILED ${file.key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(
      `  ${segment.padEnd(22)} local ${String(local.length).padStart(4)}  ` +
        `${WRITE && !VERIFY_ONLY ? "copied" : "would copy"} ${String(segCopied).padStart(4)}  ` +
        `already present ${String(segSkipped).padStart(4)}`,
    );
  }

  console.log("");
  console.log(`bucket:          ${bucket}`);
  console.log(`mode:            ${VERIFY_ONLY ? "VERIFY ONLY" : WRITE ? "WRITE" : "DRY RUN"}`);
  console.log(`${WRITE && !VERIFY_ONLY ? "copied" : "outstanding"}:      ${copied} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`already present: ${skipped}`);
  if (mismatched > 0) console.log(`size mismatches: ${mismatched} (re-copied)`);
  if (failed > 0) console.log(`FAILED:          ${failed}`);

  if (!WRITE && !VERIFY_ONLY) {
    console.log("\nDry run. Re-run with --write to copy.");
  }
  if (VERIFY_ONLY && copied === 0 && failed === 0) {
    console.log("\nEvery local file is present in the bucket at the same size.");
  }

  // A non-zero exit on failure so a wrapper or a later CI step can tell.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
