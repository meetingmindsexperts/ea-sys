import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";
import { denyContactAccess } from "@/lib/contact-visibility";

export async function GET(req: Request) {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Staff + MEMBER only — the tag vocabulary is CRM metadata (contacts review H1).
    const denied = denyContactAccess(ctx);
    if (denied) return denied;

    // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    return await runWithTenant(ctx.organizationId, async () => {

    const contacts = await db.contact.findMany({
      where: { organizationId: ctx.organizationId },
      select: { tags: true },
    });

    const tags = [...new Set(contacts.flatMap((c) => c.tags))].sort((a, b) =>
      a.localeCompare(b)
    );

    const response = NextResponse.json({ tags });
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching contact tags" });
    return NextResponse.json({ error: "Failed to fetch tags" }, { status: 500 });
  }
}
