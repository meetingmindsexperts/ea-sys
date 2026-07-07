import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { listArchives, resolveArchivePath, runLogArchiveTick } from "@/lib/log-archive";

async function requireSuperAdmin() {
  const session = await auth();
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }), session: null };
  if (session.user.role !== "SUPER_ADMIN") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }), session: null };
  return { error: null, session };
}

/**
 * GET (no ?file) → list the monthly log archives.
 * GET ?file=systemlog-YYYY-MM.jsonl.gz → download that archive (gzip).
 * SUPER_ADMIN only — archives can contain log lines with sensitive context.
 */
export async function GET(req: Request) {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const file = new URL(req.url).searchParams.get("file");
  if (!file) {
    const archives = await listArchives();
    return NextResponse.json({ archives });
  }

  const filePath = resolveArchivePath(file);
  if (!filePath) {
    apiLogger.warn({ msg: "log-archive:invalid-download-name", file });
    return NextResponse.json({ error: "Invalid archive name" }, { status: 400 });
  }
  try {
    const webStream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new Response(webStream, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${file}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    apiLogger.warn({ err, msg: "log-archive:download-failed", file });
    return NextResponse.json({ error: "Archive not found" }, { status: 404 });
  }
}

/** POST → run the archival now (instead of waiting for the monthly cron). */
export async function POST() {
  const { error, session } = await requireSuperAdmin();
  if (error) return error;
  try {
    const result = await runLogArchiveTick();
    apiLogger.info({ msg: "log-archive:manual-run", ...result, userId: session.user.id });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    apiLogger.error({ err, msg: "log-archive:manual-run-failed" });
    return NextResponse.json({ error: "Archive run failed" }, { status: 500 });
  }
}
