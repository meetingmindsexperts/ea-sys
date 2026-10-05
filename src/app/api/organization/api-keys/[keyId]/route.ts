import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/permissions/require-permission";
import { apiLogger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ keyId: string }>;
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [session, { keyId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "apiKeys.manage", { route: "organization/api-keys/[keyId]:DELETE" });
    if (!gate.ok) return gate.response;

    const key = await db.apiKey.findFirst({
      where: { id: keyId, organizationId: session.user.organizationId! },
      select: { id: true },
    });

    if (!key) return NextResponse.json({ error: "API key not found" }, { status: 404 });

    await db.apiKey.delete({ where: { id: keyId } });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to delete API key" });
    return NextResponse.json(
      { error: "Failed to delete API key" },
      { status: 500 }
    );
  }
}
