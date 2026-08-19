import { NextResponse } from "next/server";
import type { ZodError } from "zod";
import { apiLogger } from "./logger";
import { StorageError } from "./storage-errors";

// Discriminated-union shape that zod returns from `safeParse` / `safeParseAsync`.
// Kept local because zod v4 doesn't re-export the named type at the top level.
type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: ZodError };

/**
 * Shared helper for returning a 400 on a Zod validation failure — AND
 * logging the field errors so the failure is never silent.
 *
 * The user's feedback ("logging is extremely important") motivated this:
 * the dashboard was showing bare "Invalid input" with no indication of
 * which field broke, and the server logs were equally blank. Any future
 * validation failure that flows through this helper produces a log row
 * with the route identifier + field errors + form errors + whatever
 * routing context the caller threads in (eventId, userId, etc.).
 *
 * Usage:
 *   const parsed = schema.safeParse(body);
 *   if (!parsed.success) {
 *     return zodErrorResponse(parsed, {
 *       route: "POST /events/[eventId]/speakers",
 *       eventId,
 *       userId: session.user.id,
 *     });
 *   }
 *
 * Returns a NextResponse ready to `return`. Context fields are merged
 * into the log payload and are expected to be JSON-serializable.
 */
export function zodErrorResponse<T>(
  parsed: SafeParseResult<T>,
  context: { route: string } & Record<string, unknown>,
): NextResponse {
  // This branch should only be called when !parsed.success — but we
  // guard anyway so a future caller misuse doesn't trip a runtime.
  if (parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const flat = parsed.error.flatten();
  apiLogger.warn({
    msg: `${context.route}:zod-validation-failed`,
    ...context,
    fieldErrors: flat.fieldErrors,
    formErrors: flat.formErrors,
  });
  return NextResponse.json(
    { error: "Invalid input", details: flat },
    { status: 400 },
  );
}

/**
 * Canonical 429 response (duplication-audit finding 6, July 21, 2026).
 *
 * `checkRateLimit` computes `retryAfterSeconds` but every route hand-built its
 * own 429 — 105 files, four body shapes, and exactly four routes that omitted
 * the RFC-9110 `Retry-After` header the project's documented rate-limit
 * contract promises. This helper is the ONE way to reject on a rate limit:
 * always sets `Retry-After`, always carries `code: "RATE_LIMITED"` +
 * `retryAfterSeconds` in the body (so agents/clients can back off on the
 * returned value instead of sleeping a fixed 30s), and always logs.
 *
 * Usage:
 *   const rl = checkRateLimit({ key, limit: 20, windowMs: 60 * 60 * 1000 });
 *   if (!rl.allowed) {
 *     return rateLimited(rl, { route: "POST /events/[eventId]/agent/execute", userId });
 *   }
 *
 * Existing compliant sites keep their inline responses until touched — new
 * code and the previously non-compliant sites use this.
 */
export function rateLimited(
  rl: { retryAfterSeconds: number },
  context: {
    route: string;
    /** Override the user-facing message (default names the wait time). */
    message?: string;
    /** Optional documented-contract fields, echoed into the body when provided. */
    limit?: number;
    windowSeconds?: number;
  } & Record<string, unknown>,
): NextResponse {
  const { message, limit, windowSeconds, ...logContext } = context;
  apiLogger.warn({
    msg: `${context.route}:rate-limited`,
    retryAfterSeconds: rl.retryAfterSeconds,
    ...logContext,
  });
  return NextResponse.json(
    {
      error: message ?? `Too many requests. Please try again in ${rl.retryAfterSeconds} seconds.`,
      code: "RATE_LIMITED",
      retryAfterSeconds: rl.retryAfterSeconds,
      ...(limit !== undefined ? { limit } : {}),
      ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    },
    { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
  );
}

/**
 * Helper for quickly logging + returning ANY non-validation 4xx/5xx.
 * Keeps the "log every failure" discipline enforced at the call site.
 *
 * Usage:
 *   if (!event) {
 *     return apiErrorResponse(404, "Event not found", {
 *       route: "PUT /events/[eventId]",
 *       eventId,
 *       userId: session.user.id,
 *     });
 *   }
 */
export function apiErrorResponse(
  status: number,
  error: string,
  context: { route: string } & Record<string, unknown>,
  extraBody?: Record<string, unknown>,
): NextResponse {
  // Log level depends on whether this is client-error (4xx) or server-
  // error (5xx). Both carry enough context to debug after the fact.
  const logPayload = {
    msg: `${context.route}:responded-${status}`,
    status,
    error,
    ...context,
  };
  if (status >= 500) {
    apiLogger.error(logPayload);
  } else {
    apiLogger.warn(logPayload);
  }
  return NextResponse.json(
    { error, ...(extraBody ?? {}) },
    { status },
  );
}

/**
 * Map a {@link StorageError} to a response, preserving the three cases as
 * distinct LOG lines while returning one indistinguishable status on the wire.
 *
 * Every authenticated document route needs exactly this mapping, so without a
 * shared helper it gets hand-rolled five times and drifts. The split that
 * matters:
 *
 *   - traversal-blocked / prefix-rejected → warn. A stored path escaped the
 *     root its own route declared. Someone should look at that.
 *   - not-found → error, plus a `FILE_MISSING` code and an operator-facing
 *     hint, because under local storage the overwhelmingly common cause is a
 *     file uploaded on a different machine.
 *
 * All three return 404. A caller must not be able to tell "you may not see
 * this" from "this does not exist", or the route becomes an existence oracle.
 *
 * Returns `null` when `err` is not a StorageError, so the caller can rethrow
 * and let its own catch handle a genuine unknown:
 *
 *   try {
 *     file = await readStoredFile(doc.url, UPLOAD_PREFIX.speakerDocs);
 *   } catch (err) {
 *     const res = storageErrorResponse(err, { route: "speaker-doc-file", documentId });
 *     if (res) return res;
 *     throw err;
 *   }
 */
export function storageErrorResponse(
  err: unknown,
  context: {
    route: string;
    /** User-facing text for the two refusal cases. Default "Not found". */
    notFoundMessage?: string;
  } & Record<string, unknown>,
): NextResponse | null {
  if (!(err instanceof StorageError)) return null;

  const { notFoundMessage, ...logContext } = context;
  const message = notFoundMessage ?? "Not found";

  if (err.reason === "not-found") {
    apiLogger.error({ msg: `${context.route}:file-missing`, ...logContext });
    return NextResponse.json(
      {
        error:
          "The file is missing on this server. With local storage, files uploaded on another machine are not present here.",
        code: "FILE_MISSING",
      },
      { status: 404 },
    );
  }

  apiLogger.warn({
    msg: `${context.route}:${err.reason}`,
    reason: err.reason,
    ...logContext,
  });
  return NextResponse.json({ error: message }, { status: 404 });
}

