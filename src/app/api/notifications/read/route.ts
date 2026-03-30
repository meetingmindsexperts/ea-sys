import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { z } from "zod";

const markReadSchema = z.union([
  z.object({ ids: z.array(z.string().min(1)), all: z.undefined() }),
  z.object({ all: z.literal(true), ids: z.undefined() }),
]);

export async function PUT(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const parsed = markReadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body. Provide { ids: string[] } or { all: true }" },
        { status: 400 }
      );
    }

    const data = parsed.data;

    const where = {
      userId: session.user.id,
      isRead: false,
      ...("ids" in data && data.ids ? { id: { in: data.ids } } : {}),
    };

    const result = await db.notification.updateMany({
      where,
      data: { isRead: true },
    });

    return NextResponse.json({ updated: result.count });
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to mark notifications as read" });
    return NextResponse.json(
      { error: "Failed to mark notifications as read" },
      { status: 500 }
    );
  }
}
