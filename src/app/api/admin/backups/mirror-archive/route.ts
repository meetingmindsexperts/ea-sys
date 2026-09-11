/**
 * /api/admin/backups/mirror-archive: the queue behind "Build archive".
 *
 * GET lists the recent requests (and which one is active); POST inserts a
 * PENDING row the `mirror-archive` worker job picks up within three minutes. One
 * build at a time: a second POST while one is PENDING or RUNNING is a 409,
 * because two concurrent zips of a 165 MB mirror is a waste and the second
 * would only duplicate the first. Downloading a finished archive goes through
 * the normal presign route (POST /api/admin/backups), which audits it.
 *
 * Operator-only, like every backups verb: the archive is every uploaded file
 * on the platform, private documents included.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { denyNonOperator } from "@/lib/platform-operator";
import { MIRROR_ARCHIVE_TTL_DAYS } from "@/lib/infra/mirror-archive-worker";

const RECENT_LIMIT = 10;

const ROW_SELECT = {
  id: true,
  status: true,
  prefix: true,
  key: true,
  fileCount: true,
  sizeBytes: true,
  error: true,
  requestedByEmail: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} as const;

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "admin-backups:archive-unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonOperator(session, { route: "admin:backups:archive:list" });
  if (denied) return denied;

  const [archives, active] = await Promise.all([
    db.mirrorArchive.findMany({ orderBy: { createdAt: "desc" }, take: RECENT_LIMIT, select: ROW_SELECT }),
    db.mirrorArchive.findFirst({ where: { status: { in: ["PENDING", "RUNNING"] } }, orderBy: { createdAt: "asc" }, select: ROW_SELECT }),
  ]);
  return NextResponse.json({ archives, active, ttlDays: MIRROR_ARCHIVE_TTL_DAYS });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "admin-backups:archive-unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonOperator(session, { route: "admin:backups:archive:request" });
  if (denied) return denied;

  const rl = checkRateLimit({
    key: `admin-backups:archive:${session.user.id}`,
    limit: 3,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, { route: "admin:backups:archive:request", userId: session.user.id, limit: 3, windowSeconds: 3600 });
  }

  const active = await db.mirrorArchive.findFirst({
    where: { status: { in: ["PENDING", "RUNNING"] } },
    orderBy: { createdAt: "asc" },
    select: ROW_SELECT,
  });
  if (active) {
    apiLogger.warn({ userId: session.user.id, activeId: active.id, activeStatus: active.status }, "admin-backups:archive-already-active");
    return NextResponse.json(
      { error: "An archive is already being built. Wait for it to finish.", code: "ARCHIVE_IN_PROGRESS", active },
      { status: 409 },
    );
  }

  const row = await db.mirrorArchive.create({
    data: { requestedById: session.user.id, requestedByEmail: session.user.email ?? null },
    select: ROW_SELECT,
  });
  apiLogger.info({ userId: session.user.id, role: session.user.role, id: row.id, ip: req.headers.get("x-real-ip") ?? undefined }, "admin-backups:archive-requested");
  return NextResponse.json({ archive: row }, { status: 201 });
}
