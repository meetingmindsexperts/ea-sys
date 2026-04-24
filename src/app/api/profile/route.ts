import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const updateProfileSchema = z.object({
  emailSignature: z.string().max(10000).nullable().optional(),
});

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        emailSignature: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json(user);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching profile" });
    return NextResponse.json({ error: "Failed to fetch profile" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const validated = updateProfileSchema.safeParse(body);
    if (!validated.success) {
        apiLogger.warn({ msg: "profile:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    const user = await db.user.update({
      where: { id: session.user.id },
      data: {
        emailSignature: validated.data.emailSignature ?? null,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        emailSignature: true,
      },
    });

    return NextResponse.json(user);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating profile" });
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }
}
