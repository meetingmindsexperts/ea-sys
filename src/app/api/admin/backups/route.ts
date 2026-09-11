/**
 * /api/admin/backups: the Singapore DR bucket's last three days (dumps,
 * uploads mirror, env snapshots) plus the three streams' freshness, and a
 * short-lived download link for ONE database dump.
 *
 * Operator-only (denyNonOperator): a dump IS the production database, so this
 * is the most sensitive download in the product. The link is a presigned S3
 * GET (5 minutes), so the bytes never pass through the box, and every link
 * minted writes an EXPORT audit row (entityType DatabaseBackup) naming who,
 * when, which file and from where. uploads/ and env/ are listed but never
 * presigned: per-file recovery is the runbook's job, and the env snapshots
 * hold every secret. There is deliberately no restore action here; a
 * restore stays a runbook run by a person on a scratch database
 * (infra/dr/README.md, "Restore the database").
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { denyNonOperator } from "@/lib/platform-operator";
import { recordExport } from "@/lib/audit-data-transfer";
import {
  DR_BACKUPS_WINDOW_HOURS,
  DR_DOWNLOAD_LINK_SECONDS,
  fetchDr,
  isDrDumpKey,
  listDrBackups,
  presignDrBackupDownload,
} from "@/lib/infra/aws-ops";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "admin-backups:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonOperator(session, { route: "admin:backups:list" });
  if (denied) return denied;

  const rl = checkRateLimit({
    key: `admin-backups:list:${session.user.id}`,
    limit: 60,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, { route: "admin:backups:list", userId: session.user.id, limit: 60, windowSeconds: 3600 });
  }

  // One round trip for the whole page. A failed stream is reported inside its
  // own block (status "error" + message), the shape the infra card uses, and
  // each reader has already logged its failure; the others still render.
  const [health, db, uploads, env] = await Promise.all([
    fetchDr(),
    listDrBackups("db"),
    listDrBackups("uploads"),
    listDrBackups("env"),
  ]);
  apiLogger.info(
    {
      userId: session.user.id,
      windowHours: DR_BACKUPS_WINDOW_HOURS,
      db: { status: db.status, count: db.objects.length, total: db.totalObjects },
      uploads: { status: uploads.status, count: uploads.objects.length, total: uploads.totalObjects },
      env: { status: env.status, count: env.objects.length, total: env.totalObjects },
      healthStatus: health.status,
    },
    "admin-backups:listed",
  );
  return NextResponse.json({ bucket: db.bucket, windowHours: DR_BACKUPS_WINDOW_HOURS, health, db, uploads, env });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "admin-backups:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonOperator(session, { route: "admin:backups:download" });
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    apiLogger.warn({ userId: session.user.id }, "admin-backups:invalid-json");
    return NextResponse.json({ error: "Invalid JSON body", code: "INVALID_JSON" }, { status: 400 });
  }
  const key = typeof (body as { key?: unknown })?.key === "string" ? (body as { key: string }).key : "";
  if (!isDrDumpKey(key)) {
    // Refused by shape, before any AWS call: only a pg_dump under db/ can
    // leave through this door. Log the attempted key (bounded) so a probe is
    // visible in /logs.
    apiLogger.warn({ userId: session.user.id, role: session.user.role, key: key.slice(0, 200) }, "admin-backups:download-refused");
    return NextResponse.json(
      { error: "Only database dumps under db/ can be downloaded from here", code: "INVALID_KEY" },
      { status: 400 },
    );
  }

  const rl = checkRateLimit({
    key: `admin-backups:download:${session.user.id}`,
    limit: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, { route: "admin:backups:download", userId: session.user.id, limit: 10, windowSeconds: 3600 });
  }

  try {
    const url = await presignDrBackupDownload(key);
    // The durable record. A dump is the whole database leaving the building,
    // so it rides the same EXPORT audit the registration and contact exports
    // use, and shows on the Activity page like them.
    recordExport(req, {
      entityType: "DatabaseBackup",
      organizationId: session.user.organizationId ?? null,
      userId: session.user.id,
      role: session.user.role,
      source: "rest",
      format: "pg_dump",
      rowCount: 1,
      filters: { key },
    });
    apiLogger.info({ userId: session.user.id, role: session.user.role, key }, "admin-backups:download-presigned");
    return NextResponse.json({ url, key, expiresInSeconds: DR_DOWNLOAD_LINK_SECONDS });
  } catch (err) {
    apiLogger.error({ err, userId: session.user.id, key }, "admin-backups:presign-failed");
    return NextResponse.json({ error: "Could not create the download link", code: "PRESIGN_FAILED" }, { status: 502 });
  }
}
