import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function getAuthenticatedUserSession() {
  const session = await auth();

  if (!session?.user) {
    return {
      session: null,
      unauthorized: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  return { session, unauthorized: null };
}

export async function validateEventAccess(eventId: string, organizationId: string) {
  const event = await db.event.findFirst({
    where: {
      id: eventId,
      organizationId,
    },
    select: { id: true },
  });

  if (!event) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  return null;
}

export function withPrivateCache<T>(response: NextResponse<T>) {
  response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
  return response;
}
