import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const registerSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email is required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  organization: z.string().optional(),
  jobTitle: z.string().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
});

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;

    // Look up event
    const event = await db.event.findFirst({
      where: {
        OR: [{ slug }, { id: slug }],
        status: { in: ["PUBLISHED", "LIVE"] },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        settings: true,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Check abstract submissions are enabled
    const settings = (event.settings || {}) as Record<string, unknown>;
    if (settings.allowAbstractSubmissions !== true) {
      return NextResponse.json(
        { error: "Abstract submissions are not open for this event" },
        { status: 403 }
      );
    }

    // Check deadline
    if (settings.abstractDeadline) {
      const deadline = new Date(settings.abstractDeadline as string);
      if (new Date() > deadline) {
        return NextResponse.json(
          { error: "The abstract submission deadline has passed" },
          { status: 403 }
        );
      }
    }

    const body = await req.json();
    const validated = registerSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;
    const emailLower = data.email.toLowerCase();

    // Check if email is already taken
    const existingUser = await db.user.findUnique({
      where: { email: emailLower },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "An account with this email already exists. Please log in instead." },
        { status: 409 }
      );
    }

    // Hash password
    const passwordHash = await bcrypt.hash(data.password, 10);

    // Create user + speaker in a transaction
    await db.$transaction(async (tx) => {
      // Create SUBMITTER user (org-independent)
      const user = await tx.user.create({
        data: {
          email: emailLower,
          passwordHash,
          firstName: data.firstName,
          lastName: data.lastName,
          role: "SUBMITTER",
          emailVerified: new Date(),
        },
      });

      // Find or create speaker linked to this event
      const existingSpeaker = await tx.speaker.findUnique({
        where: {
          eventId_email: {
            eventId: event.id,
            email: emailLower,
          },
        },
      });

      if (existingSpeaker) {
        await tx.speaker.update({
          where: { id: existingSpeaker.id },
          data: {
            userId: user.id,
            firstName: data.firstName,
            lastName: data.lastName,
            ...(data.organization && { organization: data.organization }),
            ...(data.jobTitle && { jobTitle: data.jobTitle }),
            ...(data.city && { city: data.city }),
            ...(data.country && { country: data.country }),
          },
        });
      } else {
        await tx.speaker.create({
          data: {
            eventId: event.id,
            userId: user.id,
            email: emailLower,
            firstName: data.firstName,
            lastName: data.lastName,
            organization: data.organization || null,
            jobTitle: data.jobTitle || null,
            city: data.city || null,
            country: data.country || null,
            status: "CONFIRMED",
          },
        });
      }
    });

    apiLogger.info({
      msg: "Submitter account created",
      eventId: event.id,
      email: emailLower,
    });

    return NextResponse.json({
      success: true,
      message: "Account created successfully. Please log in to submit your abstract.",
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating submitter account" });
    return NextResponse.json(
      { error: "Failed to create account" },
      { status: 500 }
    );
  }
}
