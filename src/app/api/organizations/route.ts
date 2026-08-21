import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyNonOperator } from "@/lib/platform-operator";
import { db } from "@/lib/db";

/** GET /api/organizations — list all orgs (SUPER_ADMIN only) */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Enumerates EVERY tenant: name, slug, logo, user and event counts.
  const denied = denyNonOperator(session, { route: "organizations:list" });
  if (denied) return denied;

  const orgs = await db.organization.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      primaryColor: true,
      _count: { select: { events: true, users: true } },
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json(orgs);
}
