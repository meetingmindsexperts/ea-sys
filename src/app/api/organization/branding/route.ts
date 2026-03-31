import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.organizationId) {
      return NextResponse.json({ name: null, logo: null, primaryColor: null });
    }

    // SUPER_ADMIN can view branding for any org via x-org-id header
    let orgId = session.user.organizationId;
    if (session.user.role === "SUPER_ADMIN") {
      const overrideOrgId = req.headers.get("x-org-id");
      if (overrideOrgId) orgId = overrideOrgId;
    }

    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { name: true, logo: true, primaryColor: true },
    });

    return NextResponse.json({
      name: org?.name ?? null,
      logo: org?.logo ?? null,
      primaryColor: org?.primaryColor ?? null,
    });
  } catch {
    return NextResponse.json({ name: null, logo: null, primaryColor: null });
  }
}
