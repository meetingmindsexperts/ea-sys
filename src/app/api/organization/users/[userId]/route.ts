import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z.enum(["ADMIN", "ORGANIZER", "REVIEWER"]).optional(),
});

interface RouteParams {
  params: Promise<{ userId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { userId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await db.user.findFirst({
      where: {
        id: userId,
        organizationId: session.user.organizationId,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
        image: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json(user);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching user" });
    return NextResponse.json(
      { error: "Failed to fetch user" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const { userId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only admins can update users (except self)
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN" && session.user.id !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const validated = updateUserSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    // Regular users can only update their own name, not role
    if (session.user.id === userId && validated.data.role && session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Cannot change your own role" }, { status: 403 });
    }

    const user = await db.user.findFirst({
      where: {
        id: userId,
        organizationId: session.user.organizationId,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const updatedUser = await db.user.update({
      where: { id: userId },
      data: validated.data,
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
        action: "UPDATE",
        entityType: "User",
        entityId: userId,
        changes: validated.data,
      },
    });

    return NextResponse.json(updatedUser);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating user" });
    return NextResponse.json(
      { error: "Failed to update user" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { userId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only admins can delete users
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Cannot delete yourself
    if (session.user.id === userId) {
      return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
    }

    const user = await db.user.findFirst({
      where: {
        id: userId,
        organizationId: session.user.organizationId,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    await db.user.delete({
      where: { id: userId },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        action: "DELETE",
        entityType: "User",
        entityId: userId,
        changes: { email: user.email },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting user" });
    return NextResponse.json(
      { error: "Failed to delete user" },
      { status: 500 }
    );
  }
}
