import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";

export async function GET(req: Request) {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching contact tags" });
    return NextResponse.json({ error: "Failed to fetch tags" }, { status: 500 });
  }
}
