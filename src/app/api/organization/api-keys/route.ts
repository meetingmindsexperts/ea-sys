import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { generateApiKey, hashApiKey, keyPrefix } from "@/lib/api-key";
import { apiLogger } from "@/lib/logger";

const createKeySchema = z.object({
  name: z.string().min(1).max(64),
  expiresAt: z.string().datetime().optional(),
});

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Only admins can manage API keys" }, { status: 403 });
    }

    const keys = await db.apiKey.findMany({
      where: { organizationId: session.user.organizationId! },
      select: {
        id: true,
        name: true,
        prefix: true,
        isActive: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(keys);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to fetch API keys" });
    return NextResponse.json(
      { error: "Failed to fetch API keys" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Only admins can manage API keys" }, { status: 403 });
    }

    const body = await req.json();
    const parsed = createKeySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "organization/api-keys:zod-validation-failed", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const rawKey = generateApiKey();
    const hash = hashApiKey(rawKey);
    const prefix = keyPrefix(rawKey);

    await db.apiKey.create({
      data: {
        organizationId: session.user.organizationId!,
        name: parsed.data.name,
        keyHash: hash,
        prefix,
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      },
    });

    // Return the plaintext key ONCE — it is never stored and cannot be retrieved again
    return NextResponse.json({ key: rawKey, prefix }, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to create API key" });
    return NextResponse.json(
      { error: "Failed to create API key" },
      { status: 500 }
    );
  }
}
