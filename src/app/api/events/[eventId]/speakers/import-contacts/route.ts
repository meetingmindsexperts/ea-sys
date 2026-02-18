import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";

type RouteParams = { params: Promise<{ eventId: string }> };

const importSchema = z.object({
  contactIds: z.array(z.string()).min(1),
});

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = importSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const { contactIds } = validated.data;

    // Verify event belongs to org and fetch existing speaker emails
    const [event, contacts, existingSpeakers] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.contact.findMany({
        where: {
          id: { in: contactIds },
          organizationId: session.user.organizationId!,
        },
        select: { id: true, email: true, firstName: true, lastName: true, company: true, jobTitle: true },
      }),
      db.speaker.findMany({
        where: { eventId },
        select: { email: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existingEmails = new Set(existingSpeakers.map((s) => s.email));
    const toCreate = contacts.filter((c) => !existingEmails.has(c.email));
    const skipped = contacts.length - toCreate.length;

    if (toCreate.length > 0) {
      await db.speaker.createMany({
        data: toCreate.map((c) => ({
          eventId,
          email: c.email,
          firstName: c.firstName,
          lastName: c.lastName,
          company: c.company ?? undefined,
          jobTitle: c.jobTitle ?? undefined,
        })),
        skipDuplicates: true,
      });
    }

    return NextResponse.json({ created: toCreate.length, skipped });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing contacts as speakers" });
    return NextResponse.json({ error: "Failed to import contacts" }, { status: 500 });
  }
}
