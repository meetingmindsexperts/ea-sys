import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getEmailLogsFor } from "@/lib/email-log";

const querySchema = z.object({
  entityType: z.enum(["REGISTRATION", "SPEAKER", "CONTACT", "USER", "OTHER"]),
  entityId: z.string().min(1).max(100),
});

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const { searchParams } = new URL(req.url);
    const parsed = querySchema.safeParse({
      entityType: searchParams.get("entityType"),
      entityId: searchParams.get("entityId"),
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid query" }, { status: 400 });
    }

    const { entityType, entityId } = parsed.data;

    // Ownership / org-scope verification: confirm the entity belongs to the
    // caller's org before returning email history — otherwise an admin from
    // a different org could query arbitrary ids.
    const orgId = session.user.organizationId ?? null;
    if (!orgId) {
      return NextResponse.json({ logs: [] });
    }

    let ownershipOk = false;
    switch (entityType) {
      case "REGISTRATION": {
        const row = await db.registration.findFirst({
          where: { id: entityId, event: { organizationId: orgId } },
          select: { id: true },
        });
        ownershipOk = !!row;
        break;
      }
      case "SPEAKER": {
        const row = await db.speaker.findFirst({
          where: { id: entityId, event: { organizationId: orgId } },
          select: { id: true },
        });
        ownershipOk = !!row;
        break;
      }
      case "CONTACT": {
        const row = await db.contact.findFirst({
          where: { id: entityId, organizationId: orgId },
          select: { id: true },
        });
        ownershipOk = !!row;
        break;
      }
      case "USER":
      case "OTHER":
        // No per-entity owner — only surface logs already tagged with the org.
        ownershipOk = true;
        break;
    }
    if (!ownershipOk) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const logs = await getEmailLogsFor(entityType, entityId, orgId);
    return NextResponse.json({ logs });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to fetch email logs" });
    return NextResponse.json({ error: "Failed to fetch email logs" }, { status: 500 });
  }
}
