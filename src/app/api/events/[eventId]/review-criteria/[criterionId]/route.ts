import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { denyReviewer } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const updateCriterionSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  weight: z.number().int().min(1).max(100).optional(),
  sortOrder: z.number().int().min(0).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; criterionId: string }>;
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, criterionId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, criterion] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.reviewCriterion.findFirst({
        where: { id: criterionId, eventId },
        select: { id: true },
      }),
    ]);

    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!criterion) return NextResponse.json({ error: "Criterion not found" }, { status: 404 });

    const body = await req.json();
    const parsed = updateCriterionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const updated = await db.reviewCriterion.update({
      where: { id: criterionId },
      data: parsed.data,
      select: { id: true, name: true, weight: true, sortOrder: true },
    });

    return NextResponse.json(updated);
  } catch (err) {
    apiLogger.error({ err }, "review-criteria:PUT failed");
    return NextResponse.json({ error: "Failed to update criterion" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, criterionId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, criterion] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.reviewCriterion.findFirst({
        where: { id: criterionId, eventId },
        select: { id: true },
      }),
    ]);

    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!criterion) return NextResponse.json({ error: "Criterion not found" }, { status: 404 });

    await db.reviewCriterion.delete({ where: { id: criterionId } });

    return NextResponse.json({ success: true });
  } catch (err) {
    apiLogger.error({ err }, "review-criteria:DELETE failed");
    return NextResponse.json({ error: "Failed to delete criterion" }, { status: 500 });
  }
}
