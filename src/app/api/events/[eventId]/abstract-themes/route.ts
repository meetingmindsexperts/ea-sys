import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { denyReviewer } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const createThemeSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  sortOrder: z.number().int().min(0).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId ?? undefined },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const themes = await db.abstractTheme.findMany({
      where: { eventId },
      select: { id: true, name: true, sortOrder: true, _count: { select: { abstracts: true } } },
      orderBy: { sortOrder: "asc" },
    });

    const response = NextResponse.json(themes);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (err) {
    apiLogger.error({ err }, "abstract-themes:GET failed");
    return NextResponse.json({ error: "Failed to fetch themes" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const parsed = createThemeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const maxOrder = await db.abstractTheme.findFirst({
      where: { eventId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const sortOrder = parsed.data.sortOrder ?? (maxOrder?.sortOrder ?? -1) + 1;

    const theme = await db.abstractTheme.create({
      data: { eventId, name: parsed.data.name, sortOrder },
      select: { id: true, name: true, sortOrder: true },
    });

    return NextResponse.json(theme, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A theme with this name already exists" }, { status: 409 });
    }
    apiLogger.error({ err }, "abstract-themes:POST failed");
    return NextResponse.json({ error: "Failed to create theme" }, { status: 500 });
  }
}
