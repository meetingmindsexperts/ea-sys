import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

/** GET /api/organizations — list all orgs (SUPER_ADMIN only) */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
