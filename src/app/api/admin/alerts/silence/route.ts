/**
 * Alert silence window — GET the current state, POST to set/lift it.
 *
 * Why this exists: every `.error()` in the app pages the operator by email, and
 * an incident IS a burst of errors. So the person fixing the outage gets paged
 * by their own remediation — restarts, replays, migrations, the lot. There was
 * no way to stop that short of a redeploy with an env var. Now there is a
 * button, and it is deliberately time-boxed: a silence that never expires is
 * how you end up not knowing production has been broken since Tuesday.
 *
 * SUPER_ADMIN only. Silencing alerts is an ops action, not an org-admin one.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { getAlertSilence, setAlertSilence } from "@/lib/admin-alert";

/** Hard cap. You can silence for a maintenance window, not for a quarter. */
const MAX_SILENCE_MINUTES = 240;

const bodySchema = z.object({
  /** Minutes to silence for. 0 (or omitted with lift=true) lifts the silence. */
  minutes: z.number().int().min(0).max(MAX_SILENCE_MINUTES),
  /** Free-text note — who silenced it and why, so the log line is useful. */
  reason: z.string().max(200).optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "admin/alerts/silence:unauthenticated" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "SUPER_ADMIN") {
    apiLogger.warn({
      msg: "admin/alerts/silence:forbidden",
      userId: session.user.id,
      role: session.user.role,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const silencedUntil = await getAlertSilence();
  return NextResponse.json({ silencedUntil: silencedUntil?.toISOString() ?? null });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "admin/alerts/silence:unauthenticated" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "SUPER_ADMIN") {
    apiLogger.warn({
      msg: "admin/alerts/silence:forbidden",
      userId: session.user.id,
      role: session.user.role,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    apiLogger.warn({
      msg: "admin/alerts/silence:invalid-input",
      userId: session.user.id,
      fieldErrors: parsed.error.flatten().fieldErrors,
    });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { minutes, reason } = parsed.data;

  try {
    const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
    await setAlertSilence(until);

    // Deliberately logged at WARN, not info: a silenced alert pipeline is an
    // abnormal state, and this line is the breadcrumb that explains why the
    // inbox went quiet. It must be findable in /logs afterwards.
    apiLogger.warn({
      msg: until ? "admin-alerts:silenced" : "admin-alerts:unsilenced",
      userId: session.user.id,
      minutes,
      until: until?.toISOString() ?? null,
      reason: reason ?? null,
    });

    return NextResponse.json({ silencedUntil: until?.toISOString() ?? null });
  } catch (error) {
    apiLogger.error({
      msg: "admin/alerts/silence:failed",
      userId: session.user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Failed to update alert silence" }, { status: 500 });
  }
}
