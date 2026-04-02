import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { denyReviewer } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const updateThemeSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; themeId: string }>;
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, themeId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, theme] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.abstractTheme.findFirst({
        where: { id: themeId, eventId },
        select: { id: true },
      }),
    ]);

    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!theme) return NextResponse.json({ error: "Theme not found" }, { status: 404 });

    const body = await req.json();
    const parsed = updateThemeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const updated = await db.abstractTheme.update({
      where: { id: themeId },
      data: parsed.data,
      select: { id: true, name: true, sortOrder: true },
    });

    return NextResponse.json(updated);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A theme with this name already exists" }, { status: 409 });
    }
    apiLogger.error({ err }, "abstract-themes:PUT failed");
    return NextResponse.json({ error: "Failed to update theme" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, themeId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, theme] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.abstractTheme.findFirst({
        where: { id: themeId, eventId },
        select: { id: true, _count: { select: { abstracts: true } } },
      }),
    ]);

    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!theme) return NextResponse.json({ error: "Theme not found" }, { status: 404 });

    if (theme._count.abstracts > 0) {
      return NextResponse.json(
        { error: `Cannot delete: ${theme._count.abstracts} abstract(s) are using this theme. Reassign them first.` },
        { status: 400 }
      );
    }

    await db.abstractTheme.delete({ where: { id: themeId } });

    return NextResponse.json({ success: true });
  } catch (err) {
    apiLogger.error({ err }, "abstract-themes:DELETE failed");
    return NextResponse.json({ error: "Failed to delete theme" }, { status: 500 });
  }
}
