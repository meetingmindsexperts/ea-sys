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

    const ticketTypes = await db.ticketType.findMany({
      where: { event: { organizationId: ctx.organizationId } },
      select: { name: true },
      distinct: ["name"],
      orderBy: { name: "asc" },
    });

    const names = ticketTypes.map((t) => t.name);

    const response = NextResponse.json(names);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=60");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching registration types" });
    return NextResponse.json({ error: "Failed to fetch registration types" }, { status: 500 });
  }
}
