import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { requirePermission } from "@/lib/permissions/require-permission";
import { DetApiError, getDetAccessToken, getDetPerformance } from "@/lib/dtcm-eticket/client";
import { getDetCredentials } from "@/lib/dtcm-eticket/credentials";
import { normalizeDtcmPerformanceCode, isValidDtcmPerformanceCode } from "@/lib/dtcm-performance-code";

/**
 * Proves the saved DET credentials work: a token, and, given a performance
 * code, that DET knows the performance for this seller (its name, dates and
 * sections). Read-only on DET's side: nothing is held or bought.
 *
 * Production calls only succeed from a DET-whitelisted IP (the EC2 box), so a
 * production test from anywhere else fails at the token step; the message
 * says so rather than leaving it to be guessed.
 */
const testSchema = z.object({
  environment: z.enum(["staging", "production"]).optional(),
  performanceCode: z.string().max(100).optional(),
});

export async function POST(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json().catch(() => ({}))]);
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const organizationId = session.user.organizationId;

    const gate = requirePermission(session, "org.credentials", { route: "organization/dtcm-eticket/test-connection:POST" });
    if (!gate.ok) return gate.response;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `dtcm-eticket-test:${organizationId}`,
      limit: 30,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: session.user.id, msg: "dtcm-eticket:test-connection-rate-limited" });
      return NextResponse.json(
        { error: "Too many requests", retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = testSchema.safeParse(body ?? {});
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten(), msg: "dtcm-eticket:test-connection-validation-failed" });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }
    const performanceCode = normalizeDtcmPerformanceCode(validated.data.performanceCode);
    if (performanceCode && !isValidDtcmPerformanceCode(performanceCode)) {
      apiLogger.warn({ userId: session.user.id, msg: "dtcm-eticket:test-connection-invalid-code" });
      return NextResponse.json(
        { error: "The performance code may use only letters, digits, - and _", code: "INVALID_DTCM_PERFORMANCE_CODE" },
        { status: 400 },
      );
    }

    const creds = await getDetCredentials(organizationId, validated.data.environment);
    if (!creds) {
      apiLogger.warn({ userId: session.user.id, environment: validated.data.environment ?? "active", msg: "dtcm-eticket:test-connection-not-configured" });
      return NextResponse.json(
        { success: false, error: "DET credentials are not saved for this environment", code: "NOT_CONFIGURED" },
        { status: 400 },
      );
    }

    try {
      await getDetAccessToken(creds);
      const performance = performanceCode ? await getDetPerformance(creds, performanceCode) : null;
      apiLogger.info({
        userId: session.user.id,
        environment: creds.environment,
        performanceCode,
        sections: performance?.sections.length ?? null,
        msg: "dtcm-eticket:test-connection-success",
      });
      return NextResponse.json({ success: true, environment: creds.environment, clientId: creds.clientId, performance });
    } catch (err) {
      if (!(err instanceof DetApiError)) throw err;
      apiLogger.warn({
        userId: session.user.id,
        environment: creds.environment,
        stage: err.stage,
        httpStatus: err.httpStatus,
        detCode: err.detCode,
        detReference: err.detReference,
        msg: "dtcm-eticket:test-connection-failed",
      });
      return NextResponse.json(
        {
          success: false,
          environment: creds.environment,
          stage: err.stage,
          detCode: err.detCode,
          error: explain(err, creds.environment),
        },
        { status: 400 },
      );
    }
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-eticket:test-connection-error" });
    return NextResponse.json({ success: false, error: "Connection test failed" }, { status: 500 });
  }
}

/** DET's answer, plus the likely cause where the raw message does not say it. */
function explain(err: DetApiError, environment: "staging" | "production"): string {
  // DET's own messages end with a full stop; do not add a second one.
  const said = err.message.replace(/\.+$/, "");
  if (err.stage === "token" && environment === "production" && (err.isNoResponse || err.httpStatus === 403)) {
    return `${said}. Production only answers from the IP address DET whitelisted for you (the live server), so this test fails from anywhere else.`;
  }
  if (err.stage === "token") return `${said}. Check the client id, client secret and API key.`;
  if (err.stage === "performanceMap" && err.httpStatus !== null && err.httpStatus < 500) {
    return `${said}. Check the performance code: DET does not know it for this seller.`;
  }
  return err.message;
}
