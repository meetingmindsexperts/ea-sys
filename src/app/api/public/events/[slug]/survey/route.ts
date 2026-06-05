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
import {
  brandingCc,
  brandingFrom,
  getDefaultTemplate,
  getEventTemplate,
  renderAndWrap,
  sendEmail,
  type EmailBranding,
} from "@/lib/email";

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

// ── GET: validate token + return config/prefill ────────────────────────

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;
    const { searchParams } = new URL(req.url);
    const rawToken = searchParams.get("token");

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
    const body = await req.json();
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
      select: {
        id: true,
        surveyCompletedAt: true,
        attendeeId: true,
        attendee: {
          select: {
            id: true,
            firstName: true,
            email: true,
            tags: true,
          },
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
      },
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

    stage = "load-config";
    const config = readSurveyConfig(
      registration.event.surveyConfig,
      registration.event.id,
    );
    if (!config) {
      apiLogger.warn({
        msg: "survey:post-no-config",
        eventId,
        registrationId,
      });
      return NextResponse.json(
        { error: "No survey is configured for this event." },
        { status: 404 },
      );
    }

    stage = "validate-answers";
    const answerResult = validateAnswers(config, rawAnswers);
    if (!answerResult.ok) {
      apiLogger.warn({
        msg: "survey:post-answers-invalid",
        eventId,
        registrationId,
        errors: answerResult.errors,
      });
      return NextResponse.json(
        { error: "Some answers are invalid", details: { errors: answerResult.errors } },
        { status: 400 },
      );
    }

    // Pre-tx dedup check — if surveyCompletedAt is already set, return
    // 200 no-op without re-firing the thank-you. The @unique constraint
    // on SurveyResponse.registrationId is the race-safe net for
    // concurrent submits; this check just avoids the tx round-trip in
    // the common "reload after submit" case.
    if (registration.surveyCompletedAt) {
      apiLogger.info({
        msg: "survey:post-already-completed",
        eventId,
        registrationId,
      });
      // Token should already be gone; if a stale clone made it here,
      // clear it so subsequent attempts also fast-fail.
      await db.verificationToken
        .delete({ where: { token: hashedToken } })
        .catch(() => {}); // already deleted is fine
      return NextResponse.json({ ok: true, alreadyCompleted: true });
    }

    stage = "persist";
    const now = new Date();
    const ipHash = hashIp(getClientIp(req));
    // Merge "survey-completed" into existing Attendee.tags without
    // duplication. Tag list lives on Attendee, not Registration —
    // mirrors how the cert Issue UI's tag filter operates today.
    const mergedTags = Array.from(
      new Set([...(registration.attendee.tags ?? []), SURVEY_COMPLETED_TAG]),
    );

    try {
      await db.$transaction(async (tx) => {
        await tx.surveyResponse.create({
          data: {
            eventId: registration.event.id,
            registrationId: registration.id,
            answers: answerResult.answers as Prisma.InputJsonValue,
            ipHash,
            submittedAt: now,
          },
        });
        await tx.registration.update({
          where: { id: registration.id },
          data: { surveyCompletedAt: now },
        });
        await tx.attendee.update({
          where: { id: registration.attendee.id },
          data: { tags: mergedTags },
        });
        await tx.verificationToken.delete({
          where: { token: hashedToken },
        });
      });
    } catch (txErr) {
      // P2002 = unique constraint on SurveyResponse.registrationId.
      // A race between two clicks landed both submits; idempotent
      // success.
      if (
        txErr instanceof Prisma.PrismaClientKnownRequestError &&
        txErr.code === "P2002"
      ) {
        apiLogger.info({
          msg: "survey:post-race-dedup",
          eventId,
          registrationId,
        });
        await db.verificationToken
          .delete({ where: { token: hashedToken } })
          .catch(() => {});
        return NextResponse.json({ ok: true, alreadyCompleted: true });
      }
      throw txErr;
    }

    // Fire-and-forget thank-you email. Failure logs but never 500s
    // the user — the response is already in the DB, the thank-you
    // is a courtesy. Goes through the per-event template registry +
    // branding pipeline so the body respects whatever the organizer
    // configured at Communications → Email Templates → Survey Thank
    // You (CME-required events override the default cert-neutral
    // body with their cert-delivery language).
    stage = "send-thankyou";
    const recipient = registration.attendee;
    if (recipient.email) {
      void (async () => {
        try {
          const dbTemplate = await getEventTemplate(
            registration.event.id,
            "survey-thankyou",
          );
          const fallback = getDefaultTemplate("survey-thankyou");
          const tpl = dbTemplate ?? fallback;
          if (!tpl) {
            apiLogger.error({
              msg: "survey:thankyou-template-missing",
              eventId,
              registrationId,
            });
            return;
          }
          const branding: EmailBranding = dbTemplate?.branding ?? {
            eventName: registration.event.name,
            emailHeaderImage: registration.event.emailHeaderImage,
            emailFooterImage: registration.event.emailFooterImage,
            emailFooterHtml: registration.event.emailFooterHtml,
            emailFromAddress: registration.event.emailFromAddress,
            emailFromName: registration.event.emailFromName,
            emailCcAddresses: registration.event.emailCcAddresses,
          };
          const vars: Record<string, string | number | undefined> = {
            firstName: recipient.firstName ?? "there",
            lastName: "",
            eventName: registration.event.name,
          };
          const rendered = renderAndWrap(tpl, vars, branding);
          await sendEmail({
            to: [{ email: recipient.email, name: recipient.firstName ?? undefined }],
            cc: brandingCc(branding, [{ email: recipient.email }]),
            from: brandingFrom(branding),
            subject: rendered.subject,
            htmlContent: rendered.htmlContent,
            textContent: rendered.textContent,
            emailType: "survey_thankyou",
            stream: "transactional",
            logContext: {
              organizationId: registration.event.organizationId,
              eventId: registration.event.id,
              entityType: "REGISTRATION",
              entityId: registration.id,
              templateSlug: "survey-thankyou",
            },
          });
        } catch (err) {
          apiLogger.warn({
            msg: "survey:thankyou-email-failed",
            err,
            eventId,
            registrationId,
          });
        }
      })();
    } else {
      apiLogger.warn({
        msg: "survey:thankyou-no-email",
        eventId,
        registrationId,
      });
    }

    apiLogger.info({
      msg: "survey:post-success",
      eventId,
      registrationId,
      answeredCount: Object.keys(answerResult.answers).length,
    });
    return NextResponse.json({ ok: true });
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
