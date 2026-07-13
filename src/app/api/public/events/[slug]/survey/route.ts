/**
 * Public survey API — tokenized form load + submit.
 *
 *   GET  /api/public/events/[slug]/survey?token=<raw>
 *     → validates the token (must be `survey:{regId}` and not expired),
 *       confirms the registration is on the URL's event, returns the
 *       current survey config + read-only prefill (name + email).
 *
 *   POST /api/public/events/[slug]/survey
 *     → body { token, answers: { [questionId]: value } }
 *     → validates token + answers vs current Event.surveyConfig
 *     → inside one transaction:
 *         · SurveyResponse.create (1:1 with Registration via @unique)
 *         · Registration.surveyCompletedAt = now()
 *         · Attendee.tags merge in "survey-completed"
 *         · VerificationToken.delete
 *     → fire-and-forget thank-you email (failure logs but doesn't 500)
 *     → 200 { ok: true }
 *
 * Idempotency: a second submit hits P2002 on SurveyResponse.registration
 * Id_unique → caught, returns 200 no-op, does NOT re-fire thank-you.
 * (Token would already be deleted by the first submit, so this only
 * matters if the client retried before the first response landed.)
 *
 * Failure logging: every branch (token-invalid, slug-mismatch, zod-
 * fail, registration-not-found, db-fail, email-fail) logs structured
 * `{ eventId, registrationId, stage }` via apiLogger.
 *
 * Plan reference: /Users/krishnapallapolu/.claude/plans/bubbly-bouncing-stream.md
 */

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import crypto from "crypto";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  checkRateLimit,
  getClientIp,
  hashVerificationToken,
} from "@/lib/security";
import {
  surveyConfigSchema,
  validateAnswers,
  type SurveyConfig,
} from "@/lib/survey/schema";
import { isShareLinkValid } from "@/lib/survey/share-link";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

const TOKEN_PREFIX = "survey:";
const SURVEY_COMPLETED_TAG = "survey-completed";

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

// Shared registration select used by both the per-registration `?token=`
// path and the self-identify `?share=` path so they feed the identical
// shape into finalizeSubmission().
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
 * Shared submit finalizer for both the `?token=` (single-use, deletes
 * the token) and `?share=` (reusable, no token to delete) paths. Loads
 * + validates the config, validates answers, dedups, persists in one
 * transaction, and fires the thank-you email. Behavior for the token
 * path is byte-for-byte what the route did inline before this refactor.
 *
 * @param deleteTokenHash  hashed VerificationToken to delete inside the
 *   transaction (token path), or null for the reusable share path.
 */
async function finalizeSubmission(
  req: Request,
  registration: SubmitRegistration,
  rawAnswers: Record<string, unknown>,
  deleteTokenHash: string | null,
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
    if (deleteTokenHash) {
      await db.verificationToken
        .delete({ where: { token: deleteTokenHash } })
        .catch(() => {});
    }
    return NextResponse.json({ ok: true, alreadyCompleted: true });
  }

  const now = new Date();
  const ipHash = hashIp(getClientIp(req));
  const mergedTags = Array.from(
    new Set([...(registration.attendee.tags ?? []), SURVEY_COMPLETED_TAG]),
  );

  try {
    await db.$transaction(async (tx) => {
      await tx.surveyResponse.create({
        data: {
          eventId,
          registrationId,
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
      if (deleteTokenHash) {
        await tx.verificationToken.delete({ where: { token: deleteTokenHash } });
      }
    });
  } catch (txErr) {
    // P2002 = unique constraint on SurveyResponse.registrationId — a
    // race between two clicks; idempotent success.
    if (
      txErr instanceof Prisma.PrismaClientKnownRequestError &&
      txErr.code === "P2002"
    ) {
      apiLogger.info({ msg: "survey:submit-race-dedup", eventId, registrationId });
      if (deleteTokenHash) {
        await db.verificationToken
          .delete({ where: { token: deleteTokenHash } })
          .catch(() => {});
      }
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
        where: { slug },
        select: { id: true, name: true, slug: true, bannerImage: true, surveyConfig: true, surveyIntroHtml: true },
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
        event: { name: event.name, slug: event.slug, bannerImage: event.bannerImage },
        introHtml: event.surveyIntroHtml,
        config,
      });
    }

    // ── Shareable-link branch (self-identify by email) ──
    // Validates the organizer-generated reusable token, then returns
    // the config WITHOUT prefill — the public page collects the email
    // and the POST resolves the registration.
    if (shareToken) {
      const shareLimit = checkRateLimit({
        key: `survey-get:ip:${getClientIp(req)}`,
        limit: 30,
        windowMs: 15 * 60 * 1000,
      });
      if (!shareLimit.allowed) {
        apiLogger.warn({ msg: "public/survey:rate-limited", retryAfterSeconds: shareLimit.retryAfterSeconds });
        return NextResponse.json(
          { error: "Too many requests" },
          { status: 429, headers: { "Retry-After": String(shareLimit.retryAfterSeconds) } },
        );
      }
      const event = await db.event.findFirst({
        where: { slug },
        select: {
          id: true, name: true, slug: true, bannerImage: true,
          surveyConfig: true, surveyShareLink: true, surveyIntroHtml: true,
        },
      });
      if (!event) {
        return NextResponse.json({ error: "Survey not found" }, { status: 404 });
      }
      const valid = isShareLinkValid(event.surveyShareLink, shareToken);
      if (!valid.ok) {
        apiLogger.info({ msg: "survey:get-share-invalid", slug, reason: valid.reason, ip: getClientIp(req) });
        return NextResponse.json(
          {
            error:
              valid.reason === "expired"
                ? "This survey link has expired. Please ask the organizer for a new link."
                : "This survey link is invalid or no longer active. Please ask the organizer for a new link.",
          },
          { status: 400 },
        );
      }
      const config = readSurveyConfig(event.surveyConfig, event.id);
      if (!config) {
        return NextResponse.json(
          { error: "No survey is configured for this event." },
          { status: 404 },
        );
      }
      return NextResponse.json({
        mode: "share",
        event: { id: event.id, name: event.name, slug: event.slug, bannerImage: event.bannerImage },
        introHtml: event.surveyIntroHtml,
        config,
      });
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
            bannerImage: true,
            surveyConfig: true,
            surveyIntroHtml: true,
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
        },
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
      },
      introHtml: registration.event.surveyIntroHtml,
      config,
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

const shareSubmitSchema = z.object({
  share: z.string().min(1),
  email: z.string().email(),
  answers: z.record(z.string(), z.unknown()),
});

/**
 * Shareable-link submit (self-identify by email). Validates the
 * organizer-generated reusable token, resolves the registration from
 * the typed email, runs a short-window soft IP dedup, then defers to
 * the shared finalizeSubmission (no token to delete — the link reuses).
 */
async function handleShareSubmit(
  req: Request,
  slug: string,
  body: unknown,
): Promise<NextResponse> {
  const parsed = shareSubmitSchema.safeParse(body);
  if (!parsed.success) {
    apiLogger.warn({ msg: "survey:share-post-invalid", slug, errors: parsed.error.flatten() });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { share: shareToken, email, answers: rawAnswers } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  const event = await db.event.findFirst({
    where: { slug },
    select: { id: true, surveyShareLink: true },
  });
  if (!event) {
    return NextResponse.json({ error: "Survey not found" }, { status: 404 });
  }

  const valid = isShareLinkValid(event.surveyShareLink, shareToken);
  if (!valid.ok) {
    apiLogger.info({ msg: "survey:share-post-invalid-token", slug, reason: valid.reason });
    return NextResponse.json(
      {
        error:
          valid.reason === "expired"
            ? "This survey link has expired. Please ask the organizer for a new link."
            : "This survey link is invalid or no longer active.",
      },
      { status: 400 },
    );
  }

  // Same email can map to multiple registrations in an event (multi-ticket
  // / re-registration): prefer an incomplete one, else treat as already
  // completed. Scoped by event slug (slug is unique) so no cross-event leak.
  const registrations = await db.registration.findMany({
    where: {
      event: { slug },
      status: { notIn: ["CANCELLED"] },
      attendee: { email: normalizedEmail },
    },
    select: SUBMIT_REGISTRATION_SELECT,
    orderBy: { createdAt: "desc" },
  });

  if (registrations.length === 0) {
    apiLogger.info({ msg: "survey:share-post-email-not-found", eventId: event.id });
    return NextResponse.json(
      {
        error:
          "We couldn't find a registration for that email at this event. Please use the email address you registered with.",
      },
      { status: 404 },
    );
  }

  const target = registrations.find((r) => !r.surveyCompletedAt) ?? registrations[0];
  if (target.surveyCompletedAt) {
    return NextResponse.json({ ok: true, alreadyCompleted: true });
  }

  // ── The IP "soft dedup" that used to live here has been REMOVED (review H1) ──
  //
  // It queried for ANY response from the same ipHash in the last 60s and 429'd —
  // keyed on the IP, NOT on the submitting registration. Every attendee on the
  // venue WiFi shares one NAT egress IP, so they all hash to the same ipHash.
  //
  // The real-world failure: the organizer puts the survey QR on the closing
  // slide and 300 people scan it at once. The first submission lands; EVERY
  // other person in the room gets 429 "A response was just submitted from this
  // device." And because submissions keep arriving, the sliding 60s window never
  // empties — so the lockout is sustained. They never complete the survey,
  // `surveyCompletedAt` is never set, and they therefore NEVER GET THEIR
  // CERTIFICATE. The guard fired hardest at the exact moment of intended use.
  //
  // The comment on the old code said the short window was "deliberate so distinct
  // registrants behind one NAT IP aren't blocked" — the author was thinking about
  // precisely this risk, and the guard did the opposite.
  //
  // And it was REDUNDANT: the double-click/refresh case it was written for is
  // already handled by `SurveyResponse.registrationId @unique`, whose P2002 is
  // caught in finalizeSubmission and returned as an idempotent 200. A guard that
  // duplicates a DB constraint can only add false positives.
  //
  // Abuse of this endpoint is bounded by the per-IP rate limit above and — for
  // the impersonation vector — by the identity check on the share path. `ipHash`
  // is still recorded on the response for the audit trail.
  return finalizeSubmission(req, target, rawAnswers, null);
}

export async function POST(req: Request, { params }: RouteParams) {
  let stage: string = "init";
  let registrationId: string | null = null;
  let eventId: string | null = null;
  try {
    const { slug } = await params;

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

    stage = "body-parse";
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    // ── Shareable-link submit (self-identify by email) ──
    // Detected by the `share` field; resolves the registration from the
    // typed email rather than a per-registration token.
    if (typeof (body as { share?: unknown }).share === "string") {
      stage = "share-submit";
      return await handleShareSubmit(req, slug, body);
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

    stage = "load-registration";
    const registration = await db.registration.findFirst({
      where: { id: registrationId, status: { notIn: ["CANCELLED"] } },
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

    // Shared finalizer — single-use token path deletes the token.
    stage = "finalize";
    return await finalizeSubmission(req, registration, rawAnswers, hashedToken);
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
