import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { verifyMobileToken } from "@/lib/mobile-jwt";

const deviceSchema = z.object({
  pushToken: z.string().min(1),
  platform: z.enum(["ios", "android"]),
});

export async function POST(req: Request) {
  try {
    // Authenticate via mobile JWT
    const authHeader = req.headers.get("authorization");
    const bearerToken = authHeader?.replace(/^Bearer\s+/i, "").trim();
    if (!bearerToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const decoded = verifyMobileToken(bearerToken);
    if (!decoded || decoded.type !== "access") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const validated = deviceSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    // Upsert: update if same user+token exists, create otherwise
    await db.deviceToken.upsert({
      where: {
        userId_pushToken: {
          userId: decoded.userId,
          pushToken: validated.data.pushToken,
        },
      },
      update: {
        platform: validated.data.platform,
      },
      create: {
        userId: decoded.userId,
        pushToken: validated.data.pushToken,
        platform: validated.data.platform,
      },
    });

    apiLogger.info({
      msg: "Device token registered",
      userId: decoded.userId,
      platform: validated.data.platform,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    apiLogger.error({ err, msg: "Device token registration error" });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    // Authenticate via mobile JWT
    const authHeader = req.headers.get("authorization");
    const bearerToken = authHeader?.replace(/^Bearer\s+/i, "").trim();
    if (!bearerToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const decoded = verifyMobileToken(bearerToken);
    if (!decoded || decoded.type !== "access") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { pushToken } = body;
    if (!pushToken || typeof pushToken !== "string") {
      return NextResponse.json(
        { error: "Missing pushToken" },
        { status: 400 }
      );
    }

    // Delete the device token (e.g., on logout)
    await db.deviceToken.deleteMany({
      where: {
        userId: decoded.userId,
        pushToken,
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    apiLogger.error({ err, msg: "Device token deletion error" });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
