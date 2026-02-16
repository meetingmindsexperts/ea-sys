import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail, emailTemplates } from "@/lib/email";

const submitAbstractSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email is required"),
  company: z.string().optional(),
  title: z.string().min(1, "Title is required"),
  content: z.string().min(1, "Abstract content is required"),
  trackId: z.string().optional(),
});

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;

    // Look up event by slug or ID
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
    const validated = submitAbstractSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    // Verify track exists if provided
    if (data.trackId) {
      const track = await db.track.findFirst({
        where: { id: data.trackId, eventId: event.id },
      });
      if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
      }
    }

    // Find or create speaker by (eventId, email)
    const speaker = await db.speaker.upsert({
      where: {
        eventId_email: {
          eventId: event.id,
          email: data.email.toLowerCase(),
        },
      },
      update: {
        firstName: data.firstName,
        lastName: data.lastName,
        ...(data.company && { company: data.company }),
      },
      create: {
        eventId: event.id,
        email: data.email.toLowerCase(),
        firstName: data.firstName,
        lastName: data.lastName,
        company: data.company || null,
        status: "CONFIRMED",
      },
    });

    // Generate management token
    const managementToken = crypto.randomBytes(32).toString("hex");

    // Create abstract
    const abstract = await db.abstract.create({
      data: {
        eventId: event.id,
        speakerId: speaker.id,
        title: data.title,
        content: data.content,
        trackId: data.trackId || null,
        status: "SUBMITTED",
        managementToken,
      },
    });

    // Send confirmation email with management link (non-blocking)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const managementLink = `${appUrl}/e/${event.slug}/abstract/${managementToken}`;

    const template = emailTemplates.abstractSubmissionConfirmation({
      recipientName: `${data.firstName} ${data.lastName}`,
      recipientEmail: data.email,
      eventName: event.name,
      abstractTitle: data.title,
      managementLink,
    });

    sendEmail({
      to: [{ email: data.email, name: `${data.firstName} ${data.lastName}` }],
      subject: template.subject,
      htmlContent: template.htmlContent,
      textContent: template.textContent,
    }).catch((err) => {
      apiLogger.error({ err, msg: "Failed to send abstract confirmation email" });
    });

    apiLogger.info({
      msg: "Public abstract submitted",
      eventId: event.id,
      abstractId: abstract.id,
      speakerEmail: data.email,
    });

    return NextResponse.json({
      success: true,
      message: "Abstract submitted successfully. Check your email for a link to track your submission.",
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error submitting public abstract" });
    return NextResponse.json(
      { error: "Failed to submit abstract" },
      { status: 500 }
    );
  }
}
