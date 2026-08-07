import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";

/**
 * Pre-flight check called from Step-1 of the public signup forms.
 *
 * It answers TWO questions with different scopes, which is the thing to hold
 * on to when reading the response:
 *
 *   `exists` / `reason`  EVENT-LOCAL. Does this email hold a live registration
 *                        on THIS event? Drives the delegate register form's
 *                        "you're already registered" branch.
 *
 *   `hasAccount`         PLATFORM-WIDE. Does a login exist for this email
 *                        anywhere? `User.email` is globally unique, so a second
 *                        account for the same address literally cannot be
 *                        created. The submitter forms therefore have to route
 *                        an existing account to sign-in rather than sign-up,
 *                        even when that account came from a different event.
 *                        Signing in then adds them to this event (see
 *                        abstract-start), so it is not the dead end the
 *                        original event-local-only note worried about.
 *
 * Contacts play no part here. A Contact is a CRM snapshot with no credentials,
 * so an imported or synced contact never makes `hasAccount` true on its own.
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
      where: await publicEventWhere(req, slug, { statuses: ["PUBLISHED", "LIVE"] }),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
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
    // Whether a platform account exists for this email — drives the abstract
    // flow's "sign in vs sign up" branch. This reveals only account existence
    // (the standard tradeoff of any email-first sign-in form), never the role.
    const hasAccount = !!account;

    if (existingReg) {
      const reason: Reason = "already_registered";
      return NextResponse.json({ exists: true, reason, canSelfUpgrade, hasAccount });
    }

    return NextResponse.json({ exists: false, canSelfUpgrade, hasAccount });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "check-email failed" });
    return NextResponse.json({ error: "Check failed" }, { status: 500 });
  }
}
