import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { zoomApiRequest, isZoomConfigured } from "@/lib/zoom";
import type { ZoomUserResponse } from "@/lib/zoom";

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.user.role !== "SUPER_ADMIN" && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `zoom-test:${session.user.organizationId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const configured = await isZoomConfigured(session.user.organizationId);
    if (!configured) {
      return NextResponse.json(
        { success: false, error: "Zoom credentials not configured" },
        { status: 400 },
      );
    }

    const user = await zoomApiRequest<ZoomUserResponse>(
      session.user.organizationId,
      "GET",
      "/users/me",
    );

    apiLogger.info(
      { userId: session.user.id, zoomEmail: user.email },
      "zoom:test-connection-success",
    );

    return NextResponse.json({
      success: true,
      account: {
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        accountId: user.account_id,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed";
    apiLogger.error({ err: error }, "zoom:test-connection-failed");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
