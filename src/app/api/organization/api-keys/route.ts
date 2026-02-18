import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { generateApiKey, hashApiKey, keyPrefix } from "@/lib/api-key";

const createKeySchema = z.object({
  name: z.string().min(1).max(64),
  expiresAt: z.string().datetime().optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyReviewer(session);
  if (denied) return denied;

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
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyReviewer(session);
  if (denied) return denied;

  const body = await req.json();
  const parsed = createKeySchema.safeParse(body);
  if (!parsed.success) {
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
}
