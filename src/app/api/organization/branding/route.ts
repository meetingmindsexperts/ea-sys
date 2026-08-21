import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveActingOrgId } from "@/lib/platform-operator";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.organizationId) {
      return NextResponse.json({ name: null, logo: null, primaryColor: null });
    }

    const orgId = resolveActingOrgId(req, session.user, session.user.organizationId, {
      route: "organization:branding",
    });

    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { name: true, logo: true, primaryColor: true },
    });

    return NextResponse.json({
      name: org?.name ?? null,
      logo: org?.logo ?? null,
      primaryColor: org?.primaryColor ?? null,
    });
  } catch (err) {
    // Non-fatal: fall back to empty branding, but never swallow silently.
    apiLogger.warn({ err, msg: "organization/branding:get-failed" });
    return NextResponse.json({ name: null, logo: null, primaryColor: null });
  }
}
