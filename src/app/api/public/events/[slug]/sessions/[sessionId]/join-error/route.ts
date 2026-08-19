import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

/**
 * Report a webinar join that failed INSIDE the browser.
 *
 * Why this route exists: the server side of a join can succeed completely and
 * the attendee still sees nothing. `generateZoomSignatureForOrg` returns a
 * signature, the zoom-join route answers 200, and the Zoom SDK then rejects the
 * join client-side (wrong credential mode, the domain missing from the
 * Marketplace allowlist, an SDK/React incompatibility). Every one of those
 * failures was previously invisible to us: the only trace was a `console.error`
 * in a browser we cannot see.
 *
 * On 2026-08-19 that meant "the webinar will not join" had to be diagnosed by
 * querying `Organization.settings` in the production database, while the logs
 * showed a clean run. This closes that hole.
 *
 * Level is WARN, deliberately. A single attendee failing to join is often local
 * to them: a flaky network, a blocked WASM asset, a browser that denied media.
 * Paging on each one during a live webinar would train everyone to ignore it.
 * The SYSTEMIC cause that makes EVERY join fail is caught server-side and does
 * page: see the `zoom:sdk-dev-credentials-on-production` error in
 * `src/lib/zoom/signature.ts`. This route supplies the per-attendee evidence
 * trail behind that alarm; it is not the alarm.
 *
 * Abuse: authentication is required, so this cannot be used anonymously to
 * flood the log surface, and it is additionally rate limited per user. The
 * reported strings come from the browser, so they are truncated and logged as
 * data, never interpolated into the message.
 */
const bodySchema = z.object({
  /** Zoom's numeric errorCode when the SDK supplies one. */
  errorCode: z.union([z.string(), z.number()]).optional(),
  /** Human-readable reason, already extracted by the embed. */
  message: z.string().max(2000).optional(),
  /** Which lifecycle step failed: loading the SDK, init, or join. */
  phase: z.enum(["loading", "joining", "joined", "unknown"]).optional(),
  /** "sdk" (in-page embed) or "url" (redirect to Zoom). */
  mode: z.string().max(32).optional(),
});

/** Browser-supplied text: keep it short and keep it out of the message. */
function clip(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ slug, sessionId }, authSession] = await Promise.all([params, auth()]);
    const ip = getClientIp(req);

    // Authenticated only. An unauthenticated caller could not have obtained a
    // signature in the first place, so it has nothing legitimate to report, and
    // requiring a session is what stops this being a log-flooding vector.
    if (!authSession?.user) {
      apiLogger.warn({ ip, slug, sessionId }, "zoom:join-error-report-unauthenticated");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `zoom-join-error:${authSession.user.id}`,
      limit: 20,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn(
        { userId: authSession.user.id, slug, sessionId },
        "zoom:join-error-report-rate-limited",
      );
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      apiLogger.warn(
        {
          userId: authSession.user.id,
          slug,
          sessionId,
          fieldErrors: parsed.error.flatten().fieldErrors,
        },
        "zoom:join-error-report-invalid-input",
      );
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    apiLogger.warn(
      {
        userId: authSession.user.id,
        slug,
        sessionId,
        ip,
        phase: parsed.data.phase ?? "unknown",
        joinMode: parsed.data.mode,
        errorCode: parsed.data.errorCode,
        reason: clip(parsed.data.message, 500),
        userAgent: clip(req.headers.get("user-agent") ?? undefined, 200),
      },
      "zoom:join-failed-in-browser",
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err }, "zoom:join-error-report-failed");
    // Never surface a failure here to the attendee: they are already looking at
    // a broken join, and a second error helps nobody.
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
