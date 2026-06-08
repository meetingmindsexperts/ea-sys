/**
 * GET /api/admin/docs/file?path=<repo-relative-path>
 *
 * Returns the content of a single doc file. Path is validated against
 * the same allowlist/blocklist the tree walker uses (extension,
 * directory blocklist, path-traversal guard) before any read happens.
 *
 * ADMIN + SUPER_ADMIN. 404 on miss/blocked rather than 403 — same
 * non-enumeration posture used elsewhere in EA-SYS for resource lookups.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readDocFile } from "@/lib/docs-fs";
import { apiLogger } from "@/lib/logger";

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      apiLogger.warn({
        msg: "admin-docs:file:forbidden",
        userId: session.user.id,
        role: session.user.role,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(req.url);
    const path = url.searchParams.get("path") ?? "";
    if (!path) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    let file;
    try {
      file = await readDocFile(path);
    } catch (e) {
      // resolveSafe() throws on traversal attempts — log + 400.
      apiLogger.warn({
        msg: "admin-docs:file:bad-path",
        userId: session.user.id,
        pathRaw: path.slice(0, 200),
        err: String(e),
      });
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }
    if (!file) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ file });
  } catch (error) {
    apiLogger.error({ err: error, msg: "admin-docs:file:failed" });
    return NextResponse.json({ error: "Failed to read file" }, { status: 500 });
  }
}
