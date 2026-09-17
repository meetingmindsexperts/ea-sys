/**
 * Public survey API — tokenized form load + submit.
 *
 *   GET  /api/public/events/[slug]/survey?token=<raw>
 *     → validates the token (must be `survey:{regId}` and not expired),
 *       confirms the registration is on the URL's event, returns the
 *       current survey config + read-only identity (name + email) + the
 *       organizer's intro and thank-you messages.
 *   GET  ...?preview=1   → builder preview (config only, never saves)
 *
 *   POST /api/public/events/[slug]/survey
 *     → body { token, answers: { [questionId]: value } }  — the submit
 *     → validates token + answers vs current Event.surveyConfig
 *     → inside one transaction:
 *         · SurveyResponse.create (1:1 with Registration via @unique)
 *         · Registration.surveyCompletedAt = now()
 *         · Attendee.tags merge in "survey-completed"
 *         · VerificationToken.delete
 *     → 200 { ok: true } (the thank-you EMAIL is sent later by the worker)
 *
 * PERSONAL LINKS ONLY (Sep 17, 2026, owner decision). A survey is reached
 * only through the `?token=` link a registrant receives in the Survey
 * Invitation email from Communications. The organizer-generated shareable
 * link (`?share=`) is retired: both of its branches now answer 410 with a
 * message pointing at the personal email. It had two defects in production:
 * it could never carry identity (so since review B1 it was only a gateway that
 * asked the visitor to type an email and mailed them their link), and that
 * gateway rendered the invitation template through a SECOND sender that did
 * not fill the same placeholders as the bulk send, so on Sep 17 every request
 * was refused by the unresolved-token guard and nothing arrived. Removing it
 * leaves one sender (bulk-email) and no page where a respondent types an email.
 *
 * Idempotency: a second submit hits P2002 on SurveyResponse.registration
 * Id_unique → caught, returns 200 no-op. (Token would already be deleted by
 * the first submit, so this only matters if the client retried before the
 * first response landed.)
 *
 * Failure logging: every branch (token-invalid, slug-mismatch, zod-
 * fail, registration-not-found, db-fail) logs structured
 * `{ eventId, registrationId, stage }` via apiLogger.
 */

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import crypto from "crypto";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { eventMatchesRequestTenant, publicEventWhere } from "@/lib/public-event";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveTenantOrg, normalizeHost } from "@/lib/tenant/resolver";
import {
  checkRateLimit,
  getClientIp,
  hashVerificationToken,
} from "@/lib/security";
import {
  surveyConfigSchema,
  validateAnswers,
  type SurveyConfig,
  SURVEY_COMPLETED_TAG,
} from "@/lib/survey/schema";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

const TOKEN_PREFIX = "survey:";

/**
 * What a retired shareable link (`?share=`) answers. 410 Gone, not 400: the
 * link was valid once and a printed QR or a forwarded message will keep
 * arriving here, so the status says "this no longer exists" and the message
 * tells the person where their real link is.
 */
const SHARE_LINK_RETIRED_MESSAGE =
  "This survey link is no longer in use. Please open the personal survey link in the email we sent you, or contact the event organizer for a new one.";

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Hash the request IP with the NEXTAUTH_SECRET pepper for storage on
 * SurveyResponse.ipHash. Same shape as `hashVerificationToken` — the
 * raw IP never lands in the DB.
 */
function hashIp(ip: string): string | null {
  const pepper = process.env.NEXTAUTH_SECRET;
  if (!pepper) return null;
  return crypto.createHash("sha256").update(`ip:${ip}:${pepper}`).digest("hex");
}

/**
 * Parse and shape-validate the stored surveyConfig JSON column.
 * Returns null (treat as "no survey") when the column is null or
 * the stored shape no longer matches the current Zod schema (e.g.
 * an older event from before the schema tightened). Logs the mis-
 * match so an organizer-side validation pass can find + fix.
 */
function readSurveyConfig(
  raw: unknown,
  eventId: string,
): SurveyConfig | null {
  if (raw === null || raw === undefined) return null;
  const result = surveyConfigSchema.safeParse(raw);
  if (!result.success) {
    apiLogger.warn({
      msg: "survey:invalid-stored-config",
      eventId,
      errors: result.error.flatten(),
    });
    return null;
  }
  return result.data;
}

// Registration select for the `?token=` submit, fed into finalizeSubmission().
const SUBMIT_REGISTRATION_SELECT = {
  id: true,
  surveyCompletedAt: true,
  attendeeId: true,
  attendee: {
    select: { id: true, firstName: true, email: true, tags: true },
  },
  event: {
    select: {
      id: true,
      name: true,
      slug: true,
      surveyConfig: true,
      emailHeaderImage: true,
      emailFooterImage: true,
      emailFooterHtml: true,
      emailFromAddress: true,
      emailFromName: true,
      emailCcAddresses: true,
      organizationId: true,
    },
  },
} satisfies Prisma.RegistrationSelect;

type SubmitRegistration = Prisma.RegistrationGetPayload<{
  select: typeof SUBMIT_REGISTRATION_SELECT;
}>;

/**
 * Submit finalizer for the `?token=` path. Loads + validates the config,
 * validates answers, dedups, and persists in one transaction that also
 * consumes the single-use token.
 *
 * @param tokenHash  hashed VerificationToken deleted inside the transaction.
 */
async function finalizeSubmission(
  req: Request,
  registration: SubmitRegistration,
  rawAnswers: Record<string, unknown>,
  tokenHash: string,
): Promise<NextResponse> {
  const eventId = registration.event.id;
  const registrationId = registration.id;

  const config = readSurveyConfig(registration.event.surveyConfig, eventId);
  if (!config) {
    apiLogger.warn({ msg: "survey:submit-no-config", eventId, registrationId });
    return NextResponse.json(
      { error: "No survey is configured for this event." },
      { status: 404 },
    );
  }

  const answerResult = validateAnswers(config, rawAnswers);
  if (!answerResult.ok) {
    apiLogger.warn({
      msg: "survey:submit-answers-invalid",
      eventId,
      registrationId,
      errors: answerResult.errors,
    });
    return NextResponse.json(
      { error: "Some answers are invalid", details: { errors: answerResult.errors } },
      { status: 400 },
    );
  }

  // Pre-tx dedup — the @unique on SurveyResponse.registrationId is the
  // race-safe net; this just avoids a tx round-trip on the common
  // "reload after submit" case.
  if (registration.surveyCompletedAt) {
    apiLogger.info({ msg: "survey:submit-already-completed", eventId, registrationId });
    await db.verificationToken
      .delete({ where: { token: tokenHash } })
      .catch((err) => apiLogger.warn({
        err,
        msg: "survey:already-completed-token-cleanup-failed",
        eventId,
        registrationId,
      }));
    return NextResponse.json({ ok: true, alreadyCompleted: true });
  }

  const now = new Date();
  const ipHash = hashIp(getClientIp(req));
  const mergedTags = Array.from(
    new Set([...(registration.attendee.tags ?? []), SURVEY_COMPLETED_TAG]),
  );

  try {
    await tenantTransaction(async (tx) => {
      await tx.surveyResponse.create({
        data: {
          eventId,
          registrationId,
          // tenancy (Domain #16): stamp the event's org on the response row.
          organizationId: registration.event.organizationId,
          answers: answerResult.answers as Prisma.InputJsonValue,
          ipHash,
          submittedAt: now,
        },
      });
      await tx.registration.update({
        where: { id: registrationId },
        data: { surveyCompletedAt: now },
      });
      await tx.attendee.update({
        where: { id: registration.attendee.id },
        data: { tags: mergedTags },
      });
      await tx.verificationToken.delete({ where: { token: tokenHash } });
    });
  } catch (txErr) {
    // P2002 = unique constraint on SurveyResponse.registrationId — a
    // race between two clicks; idempotent success.
    if (
      txErr instanceof Prisma.PrismaClientKnownRequestError &&
      txErr.code === "P2002"
    ) {
      apiLogger.info({ msg: "survey:submit-race-dedup", eventId, registrationId });
      await db.verificationToken
        .delete({ where: { token: tokenHash } })
        .catch((err) => apiLogger.warn({
          err,
          msg: "survey:race-dedup-token-cleanup-failed",
          eventId,
          registrationId,
        }));
      return NextResponse.json({ ok: true, alreadyCompleted: true });
    }
    throw txErr;
  }

  // Thank-you email is DEFERRED to the cert-issue worker's survey-thankyou
  // sweep (runSurveyThankYouSweep) — NOT sent inline here. The sweep holds the
  // thank-you until the attendee's auto-issued certificate PDF is rendered,
  // then sends ONE email with the cert attached (or a plain thank-you after a
  // 15-min fallback / if they earn no cert). See survey-thankyou-sweep.ts.
  if (!registration.attendee.email) {
    apiLogger.warn({ msg: "survey:thankyou-no-email", eventId, registrationId });
  }

  apiLogger.info({
    msg: "survey:submit-success",
    eventId,
    registrationId,
    answeredCount: Object.keys(answerResult.answers).length,
  });
  return NextResponse.json({ ok: true });
}

// ── GET: validate token + return config/prefill ────────────────────────

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;
    const { searchParams } = new URL(req.url);
    const rawToken = searchParams.get("token");
    const shareToken = searchParams.get("share");
    const isPreview = searchParams.get("preview") === "1";

    // ── Preview branch (FIRST — no token, no PII, no DB write) ──
    // The builder's "Preview" button opens this so an organizer can
    // eyeball the form. Returns config only; the public page disables
    // submit. Exposing the questions publicly is acceptable — every
    // invited registrant already sees the identical set.
    if (isPreview) {
      const previewLimit = checkRateLimit({
        key: `survey-get:ip:${getClientIp(req)}`,
        limit: 30,
        windowMs: 15 * 60 * 1000,
      });
      if (!previewLimit.allowed) {
        apiLogger.warn({ msg: "public/survey:rate-limited", retryAfterSeconds: previewLimit.retryAfterSeconds });
        return NextResponse.json(
          { error: "Too many requests" },
          { status: 429, headers: { "Retry-After": String(previewLimit.retryAfterSeconds) } },
        );
      }
      const event = await db.event.findFirst({
        where: await publicEventWhere(req, slug),
        select: { id: true, name: true, slug: true, bannerImage: true, bannerImageMobile: true, surveyConfig: true, surveyIntroHtml: true, surveyThankYouHtml: true },
      });
      if (!event) {
        return NextResponse.json({ error: "Survey not found" }, { status: 404 });
      }
      const config = readSurveyConfig(event.surveyConfig, event.id);
      if (!config) {
        return NextResponse.json(
          { error: "No survey is configured for this event yet." },
          { status: 404 },
        );
      }
      return NextResponse.json({
        mode: "preview",
        event: { name: event.name, slug: event.slug, bannerImage: event.bannerImage, bannerImageMobile: event.bannerImageMobile },
        introHtml: event.surveyIntroHtml,
        thankYouHtml: event.surveyThankYouHtml,
        config,
      });
    }

    // ── Retired shareable link (Sep 17, 2026) ──
    // Answered before the token check so an old `?share=` URL gets a message
    // that says where the real link is, not "Token is required". No DB read.
    if (shareToken) {
      apiLogger.info({ msg: "survey:share-link-retired", slug, method: "GET", ip: getClientIp(req) });
      return NextResponse.json({ error: SHARE_LINK_RETIRED_MESSAGE }, { status: 410 });
    }

    if (!rawToken) {
      apiLogger.warn({ msg: "survey:get-missing-token", slug, ip: getClientIp(req) });
      return NextResponse.json({ error: "Token is required" }, { status: 400 });
    }

    // 30 GETs / 15 min / IP — generous for legitimate retries (slow
    // network, page reload) but rejects scrape attempts. Lower than
    // complete-registration because the survey GET reveals more
    // (PII prefill + whole question set).
    const ipLimit = checkRateLimit({
      key: `survey-get:ip:${getClientIp(req)}`,
      limit: 30,
      windowMs: 15 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      apiLogger.warn({ msg: "survey:get-rate-limited", ip: getClientIp(req) });
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } },
      );
    }

    const hashedToken = hashVerificationToken(rawToken);
    const tokenRecord = await db.verificationToken.findUnique({
      where: { token: hashedToken },
    });

    if (!tokenRecord) {
      apiLogger.info({
        msg: "survey:get-token-not-found",
        slug,
        ip: getClientIp(req),
      });
      return NextResponse.json(
        { error: "This survey link is invalid or has already been used. Please contact the event organizer for a new link." },
        { status: 400 },
      );
    }

    if (tokenRecord.expires < new Date()) {
      await db.verificationToken.delete({ where: { token: hashedToken } });
      apiLogger.info({
        msg: "survey:get-token-expired",
        identifier: tokenRecord.identifier,
        ip: getClientIp(req),
      });
      return NextResponse.json(
        { error: "This survey link has expired. Please contact the event organizer for a new link." },
        { status: 400 },
      );
    }

    if (!tokenRecord.identifier.startsWith(TOKEN_PREFIX)) {
      apiLogger.warn({
        msg: "survey:get-token-wrong-prefix",
        identifier: tokenRecord.identifier,
      });
      return NextResponse.json(
        { error: "This link is not a survey link." },
        { status: 400 },
      );
    }
    const registrationId = tokenRecord.identifier.slice(TOKEN_PREFIX.length);

    // Tenancy sweep: open the tenant store BEFORE the swept Registration read
    // (resolved from HOST — the token path resolves the registration by
    // token→id and reads no un-swept Event first). Passthrough on master.
    const tenant = await resolveTenantOrg(normalizeHost(req.headers.get("host")));
    return await runWithTenant(tenant.orgId ?? "", async () => {
    const registration = await db.registration.findFirst({
      where: { id: registrationId, status: { notIn: ["CANCELLED"] } },
      select: {
        id: true,
        surveyCompletedAt: true,
        attendee: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            title: true,
          },
        },
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            organizationId: true,
            bannerImage: true,
            bannerImageMobile: true,
            surveyConfig: true,
            surveyIntroHtml: true,
            surveyThankYouHtml: true,
          },
        },
      },
    });

    if (!registration) {
      apiLogger.warn({
        msg: "survey:get-registration-not-found",
        registrationId,
        slug,
      });
      return NextResponse.json(
        { error: "Registration not found or has been cancelled" },
        { status: 404 },
      );
    }

    // Defense-in-depth: token's registration must live on the URL's event.
    // A token issued for event A pasted into event B's URL is rejected.
    if (registration.event.slug !== slug) {
      apiLogger.warn({
        msg: "survey:get-slug-mismatch",
        registrationId,
        tokenSlug: registration.event.slug,
        urlSlug: slug,
      });
      return NextResponse.json(
        { error: "This link does not match the event. Please use the original link from your email." },
        { status: 400 },
      );
    }
    if (!(await eventMatchesRequestTenant(req, registration.event.organizationId))) {
      apiLogger.warn({ msg: "survey:get-tenant-mismatch", registrationId, urlSlug: slug });
      return NextResponse.json(
        { error: "This link does not match the event. Please use the original link from your email." },
        { status: 400 },
      );
    }

    const config = readSurveyConfig(
      registration.event.surveyConfig,
      registration.event.id,
    );
    if (!config) {
      apiLogger.warn({
        msg: "survey:get-no-config",
        eventId: registration.event.id,
        registrationId,
      });
      return NextResponse.json(
        { error: "No survey is configured for this event." },
        { status: 404 },
      );
    }

    // Already submitted? Return the same `alreadyCompleted` flag the
    // public form uses to render the thank-you state without re-
    // showing the form. We don't expose the existing answers — that
    // would let a leaked token leak the response back; the operator
    // sees it in the dashboard.
    if (registration.surveyCompletedAt) {
      return NextResponse.json({
        alreadyCompleted: true,
        event: {
          name: registration.event.name,
          slug: registration.event.slug,
          bannerImage: registration.event.bannerImage,
          bannerImageMobile: registration.event.bannerImageMobile,
        },
        thankYouHtml: registration.event.surveyThankYouHtml,
      });
    }

    return NextResponse.json({
      alreadyCompleted: false,
      registration: { id: registration.id },
      attendee: registration.attendee,
      event: {
        id: registration.event.id,
        name: registration.event.name,
        slug: registration.event.slug,
        bannerImage: registration.event.bannerImage,
        bannerImageMobile: registration.event.bannerImageMobile,
      },
      introHtml: registration.event.surveyIntroHtml,
      thankYouHtml: registration.event.surveyThankYouHtml,
      config,
    });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "survey:get-unhandled" });
    return NextResponse.json(
      { error: "An unexpected error occurred while loading the survey. Please try again." },
      { status: 500 },
    );
  }
}

// ── POST: submit ──────────────────────────────────────────────────────

const submitBodySchema = z.object({
  token: z.string().min(1),
  // `answers` is an open record because the keys are question ids
  // generated at builder time. Per-config shape validation happens
  // via validateAnswers() once we've loaded the config.
  answers: z.record(z.string(), z.unknown()),
});

export async function POST(req: Request, { params }: RouteParams) {
  let stage: string = "init";
  let registrationId: string | null = null;
  let eventId: string | null = null;
  try {
    const { slug } = await params;

    stage = "body-parse";
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    // ── Retired shareable link (Sep 17, 2026) ──
    // The old "email me my survey link" request. Refused before the submit
    // rate limit, with no DB read and no email sent.
    if (typeof (body as { share?: unknown }).share === "string") {
      apiLogger.info({ msg: "survey:share-link-retired", slug, method: "POST", ip: getClientIp(req) });
      return NextResponse.json({ error: SHARE_LINK_RETIRED_MESSAGE }, { status: 410 });
    }

    // 10 POSTs / 15 min / IP — stricter than GET because each is a
    // DB-write attempt. Legitimate users submit once; bots get cut off.
    const ipLimit = checkRateLimit({
      key: `survey-post:ip:${getClientIp(req)}`,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      apiLogger.warn({ msg: "survey:post-rate-limited", ip: getClientIp(req) });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } },
      );
    }

    // ── Per-registration token submit (existing single-use path) ──
    const bodyValidated = submitBodySchema.safeParse(body);
    if (!bodyValidated.success) {
      apiLogger.warn({
        msg: "survey:post-body-invalid",
        slug,
        errors: bodyValidated.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: bodyValidated.error.flatten() },
        { status: 400 },
      );
    }
    const { token: rawToken, answers: rawAnswers } = bodyValidated.data;

    stage = "token-validate";
    const hashedToken = hashVerificationToken(rawToken);
    const tokenRecord = await db.verificationToken.findUnique({
      where: { token: hashedToken },
    });

    if (!tokenRecord) {
      apiLogger.info({
        msg: "survey:post-token-not-found",
        slug,
        ip: getClientIp(req),
      });
      return NextResponse.json(
        { error: "This survey link is invalid or has already been used." },
        { status: 400 },
      );
    }

    if (tokenRecord.expires < new Date()) {
      await db.verificationToken.delete({ where: { token: hashedToken } });
      apiLogger.info({
        msg: "survey:post-token-expired",
        identifier: tokenRecord.identifier,
      });
      return NextResponse.json(
        { error: "This survey link has expired." },
        { status: 400 },
      );
    }

    if (!tokenRecord.identifier.startsWith(TOKEN_PREFIX)) {
      apiLogger.warn({
        msg: "survey:post-token-wrong-prefix",
        identifier: tokenRecord.identifier,
      });
      return NextResponse.json(
        { error: "This link is not a survey link." },
        { status: 400 },
      );
    }
    registrationId = tokenRecord.identifier.slice(TOKEN_PREFIX.length);
    // Capture as a const: the outer `registrationId` is a `let` (for catch
    // logging), so its non-null narrowing would be lost inside the closure below.
    const resolvedRegistrationId = registrationId;

    // Tenancy sweep: open the tenant store BEFORE the swept Registration read
    // (resolved from HOST — the token path resolves the registration by
    // token→id and reads no un-swept Event first). Passthrough on master.
    const tenant = await resolveTenantOrg(normalizeHost(req.headers.get("host")));
    return await runWithTenant(tenant.orgId ?? "", async () => {
    stage = "load-registration";
    const registration = await db.registration.findFirst({
      where: { id: resolvedRegistrationId, status: { notIn: ["CANCELLED"] } },
      select: SUBMIT_REGISTRATION_SELECT,
    });

    if (!registration) {
      apiLogger.warn({
        msg: "survey:post-registration-not-found",
        registrationId,
        slug,
      });
      return NextResponse.json(
        { error: "Registration not found or has been cancelled" },
        { status: 404 },
      );
    }
    eventId = registration.event.id;

    if (registration.event.slug !== slug) {
      apiLogger.warn({
        msg: "survey:post-slug-mismatch",
        registrationId,
        tokenSlug: registration.event.slug,
        urlSlug: slug,
      });
      return NextResponse.json(
        { error: "This link does not match the event." },
        { status: 400 },
      );
    }
    if (!(await eventMatchesRequestTenant(req, registration.event.organizationId))) {
      apiLogger.warn({ msg: "survey:post-tenant-mismatch", registrationId, urlSlug: slug });
      return NextResponse.json(
        { error: "This link does not match the event." },
        { status: 400 },
      );
    }

    // Finalizer consumes the single-use token inside the transaction.
    stage = "finalize";
    return await finalizeSubmission(req, registration, rawAnswers, hashedToken);
    });
  } catch (err) {
    apiLogger.error({
      err,
      msg: "survey:post-unhandled",
      stage,
      eventId,
      registrationId,
    });
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
