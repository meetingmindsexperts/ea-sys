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
import { denyNonOperator } from "@/lib/platform-operator";
import { buildDocsTree } from "@/lib/docs-fs";
import { apiLogger } from "@/lib/logger";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // PLATFORM OPERATOR only, narrowed from ADMIN on Aug 21 2026.
    //
    // This serves every .md and .html in the repository. The original comment
    // justified ADMIN access on the grounds that it "contains no secrets" —
    // true when every ADMIN was an MMG employee, and not the same claim once
    // ADMIN can mean a customer's administrator on the platform instance. What
    // is in here: our incident log, the AWS runbook with instance ids and
    // bucket names, the procedure for rebuilding our production box, the
    // security posture we gave a health authority, our multi-tenancy strategy
    // and our CRM plans. None of that is a tenant's to read.
    const denied = denyNonOperator(session, { route: "admin-docs:tree" });
    if (denied) return denied;

    const tree = await buildDocsTree();
    return NextResponse.json({ tree });
  } catch (error) {
    apiLogger.error({ err: error, msg: "admin-docs:tree:failed" });
    return NextResponse.json({ error: "Failed to build docs tree" }, { status: 500 });
  }
}
