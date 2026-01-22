import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { slugify } from "@/lib/utils";
import { apiLogger } from "@/lib/logger";

const registerSchema = z.object({
  organizationName: z.string().min(2),
  firstName: z.string().min(2),
  lastName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const validated = registerSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { organizationName, firstName, lastName, email, password } =
      validated.data;

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

    // Create organization slug
    let slug = slugify(organizationName);
    const existingOrg = await db.organization.findUnique({
      where: { slug },
    });

    if (existingOrg) {
      slug = `${slug}-${Date.now()}`;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create organization and user in a transaction
    const result = await db.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: organizationName,
          slug,
        },
      });

      const user = await tx.user.create({
        data: {
          organizationId: organization.id,
          email,
          passwordHash,
          firstName,
          lastName,
          role: "ADMIN",
        },
      });

      return { organization, user };
    });

    return NextResponse.json(
      {
        message: "Account created successfully",
        user: {
          id: result.user.id,
          email: result.user.email,
          firstName: result.user.firstName,
          lastName: result.user.lastName,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "Registration error" });
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
