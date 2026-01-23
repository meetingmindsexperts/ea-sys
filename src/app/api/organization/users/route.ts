import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const inviteUserSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(["ADMIN", "ORGANIZER", "REVIEWER"]),
});

export async function GET() {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const users = await db.user.findMany({
      where: { organizationId: session.user.organizationId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
        image: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(users);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching users" });
    return NextResponse.json(
      { error: "Failed to fetch users" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only admins can invite users
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const validated = inviteUserSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { email, firstName, lastName, role } = validated.data;

    // Check if user already exists
    const existingUser = await db.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "User with this email already exists" },
        { status: 400 }
      );
    }

    // Generate a temporary password (in production, send an invite email instead)
    const tempPassword = Math.random().toString(36).slice(-8);
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const user = await db.user.create({
      data: {
        organizationId: session.user.organizationId,
        email,
        firstName,
        lastName,
        role,
        passwordHash,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
      },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        action: "CREATE",
        entityType: "User",
        entityId: user.id,
        changes: { email, firstName, lastName, role },
      },
    });

    // In production, you would send an email with the temp password or invite link
    return NextResponse.json({ ...user, tempPassword }, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating user" });
    return NextResponse.json(
      { error: "Failed to create user" },
      { status: 500 }
    );
  }
}
