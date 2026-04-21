import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";

/**
 * Pre-flight check called from Step-1 of the public signup forms.
 * Scope: **event-local only** — we report whether this email has a live
 * registration on this specific event. Cross-event user accounts are
 * intentionally NOT reported here: the server-side register route will
 * link to the existing User silently by email, and surfacing the
 * global account in the UI creates a dead-end flow where someone
 * registered for another event gets sent to /my-registration and sees
 * nothing for *this* event.
 */
const bodySchema = z.object({
  email: z.string().email().max(255),
});

type Reason = "already_registered";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;

    // 20/hr/IP — cheap endpoint, but this is a public one.
    const ip = getClientIp(req);
    const rate = checkRateLimit({
      key: `check-email:${ip}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!rate.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
      );
    }

    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }
    const email = parsed.data.email.toLowerCase();

    const event = await db.event.findFirst({
      where: { slug, status: { in: ["PUBLISHED", "LIVE"] } },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existingReg = await db.registration.findFirst({
      where: {
        eventId: event.id,
        attendee: { email },
        status: { not: "CANCELLED" },
      },
      select: { id: true },
    });
    if (existingReg) {
      const reason: Reason = "already_registered";
      return NextResponse.json({ exists: true, reason });
    }

    return NextResponse.json({ exists: false });
  } catch (error) {
    apiLogger.error({ err: error, msg: "check-email failed" });
    return NextResponse.json({ error: "Check failed" }, { status: 500 });
  }
}
