import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";

/**
 * Pre-flight check called from Step-1 of the public signup forms.
 * Returns whether the given email already has a registration for this
 * event OR a user account. The response is intentionally uniform
 * ({ exists, reason }) so an attacker can't use this to enumerate
 * accounts beyond what they could learn from the register/login pages.
 */
const bodySchema = z.object({
  email: z.string().email().max(255),
});

type Reason = "already_registered" | "user_exists";

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

    // Fastest check first: is there already a registration for this event with
    // this email? If yes, the signup can't proceed; the existing account is the
    // natural next step.
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

    // Fallback: no registration yet, but the user may already have an account
    // from another event. We'd still let them sign up (the register route
    // reuses the existing user), but the UI should offer "sign in instead"
    // so they don't create a duplicate password.
    const existingUser = await db.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingUser) {
      const reason: Reason = "user_exists";
      return NextResponse.json({ exists: true, reason });
    }

    return NextResponse.json({ exists: false });
  } catch (error) {
    apiLogger.error({ err: error, msg: "check-email failed" });
    return NextResponse.json({ error: "Check failed" }, { status: 500 });
  }
}
