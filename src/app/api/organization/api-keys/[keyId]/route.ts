import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";

interface RouteParams {
  params: Promise<{ keyId: string }>;
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const [session, { keyId }] = await Promise.all([auth(), params]);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyReviewer(session);
  if (denied) return denied;

  const key = await db.apiKey.findFirst({
    where: { id: keyId, organizationId: session.user.organizationId! },
    select: { id: true },
  });

  if (!key) return NextResponse.json({ error: "API key not found" }, { status: 404 });

  await db.apiKey.delete({ where: { id: keyId } });

  return NextResponse.json({ success: true });
}
