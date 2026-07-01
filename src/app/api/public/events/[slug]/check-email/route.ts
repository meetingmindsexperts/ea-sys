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

    // 200/hr/IP — cheap preflight endpoint. Raised from 20 so a shared NAT
    // (hospital/office/venue) where many people check their email before
    // registering isn't exhausted; still bounded for a public endpoint.
    const ip = getClientIp(req);
    const rate = checkRateLimit({
      key: `check-email:${ip}`,
      limit: 200,
      windowMs: 60 * 60 * 1000,
    });
    if (!rate.allowed) {
      apiLogger.warn({ msg: "public/check-email:rate-limited", retryAfterSeconds: rate.retryAfterSeconds, ip });
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
      );
    }

    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "public/check-email:invalid-input", errors: parsed.error.flatten() });
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

    const [existingReg, account] = await Promise.all([
      db.registration.findFirst({
        where: {
          eventId: event.id,
          attendee: { email },
          status: { not: "CANCELLED" },
        },
        select: { id: true },
      }),
      // Look up the account only to decide ONE coarse thing (below). We never
      // return the raw role — this is a public, unauthenticated endpoint and
      // leaking whether an email is an ADMIN/ORGANIZER/etc. would let anyone
      // harvest privileged accounts for phishing.
      db.user.findUnique({ where: { email }, select: { role: true } }),
    ]);

    // Can the abstract-submission flow take this email through the self-serve
    // submitter form? True for no account or a plain REGISTRANT (the submitter
    // route upgrades REGISTRANT→SUBMITTER); false for an existing SUBMITTER /
    // staff account, who must sign in instead. Coarse boolean by design —
    // collapses every privileged role into "false" so nothing is enumerable.
    const canSelfUpgrade = !account || account.role === "REGISTRANT";

    if (existingReg) {
      const reason: Reason = "already_registered";
      return NextResponse.json({ exists: true, reason, canSelfUpgrade });
    }

    return NextResponse.json({ exists: false, canSelfUpgrade });
  } catch (error) {
    apiLogger.error({ err: error, msg: "check-email failed" });
    return NextResponse.json({ error: "Check failed" }, { status: 500 });
  }
}
