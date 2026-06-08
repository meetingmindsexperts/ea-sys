/**
 * GET /api/admin/docs/tree
 *
 * Returns the in-repo docs tree (every .md / .html outside the blocklist)
 * as a nested structure for the sidebar nav on /admin/docs.
 *
 * ADMIN + SUPER_ADMIN — internal architecture notes, runbooks, and
 * decision history that admins benefit from but aren't operator-facing.
 * REVIEWER / SUBMITTER / REGISTRANT / MEMBER blocked (docs include
 * deploy procedures + IAM patterns inappropriate for those roles).
 *
 * Source of truth is the filesystem at request time; docs auto-refresh
 * on every deploy because scripts/deploy.sh pulls the latest commit.
 * No cache layer because the tree is cheap to build (~30 files) and
 * any cache would just delay seeing edits during local dev.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildDocsTree } from "@/lib/docs-fs";
import { apiLogger } from "@/lib/logger";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      apiLogger.warn({
        msg: "admin-docs:tree:forbidden",
        userId: session.user.id,
        role: session.user.role,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const tree = await buildDocsTree();
    return NextResponse.json({ tree });
  } catch (error) {
    apiLogger.error({ err: error, msg: "admin-docs:tree:failed" });
    return NextResponse.json({ error: "Failed to build docs tree" }, { status: 500 });
  }
}
