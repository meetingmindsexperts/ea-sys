import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyNonOperator } from "@/lib/platform-operator";
import { dbOperator } from "@/lib/db";

/** GET /api/organizations — list all orgs (SUPER_ADMIN only) */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Enumerates EVERY tenant: name, slug, logo, user and event counts.
  const denied = denyNonOperator(session, { route: "organizations:list" });
  if (denied) return denied;

  // The privileged client (review of 9c0a24c5): the list is across tenants by
  // design and behind denyNonOperator, and the event count under each
  // organisation is a read of Event, which carries a row policy. On the app's
  // client, outside any lane, every tenant showed "0 events".
  const orgs = await dbOperator.organization.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      primaryColor: true,
      enabledModules: true,
      _count: { select: { events: true, users: true } },
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json(orgs);
}
