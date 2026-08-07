/**
 * Public survey API — tokenized form load + submit.
 *
 *   GET  /api/public/events/[slug]/survey?token=<raw>
 *     → validates the token (must be `survey:{regId}` and not expired),
 *       confirms the registration is on the URL's event, returns the
 *       current survey config + read-only prefill (name + email).
 *
 *   POST /api/public/events/[slug]/survey
 *     → body { share, email }  — shareable-link "email me my link". Mints the
 *       per-registration token and EMAILS it; never submits a survey and never
 *       stamps surveyCompletedAt (review B1 — that flag mints a CME
 *       certificate, so a typed email may not set it). Always returns the same
 *       generic message, so it is not an email-enumeration oracle.
 *     → body { token, answers: { [questionId]: value } }  — the real submit
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
} from "@/lib/survey/schema";
import {
  isShareLinkValid,
  DEFAULT_SURVEY_EXPIRY_DAYS,
  DAY_MS,
} from "@/lib/survey/share-link";
import {
  getEventTemplate,
  renderAndWrap,
  brandingFrom,
  brandingCc,
  sendEmail,
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
        where: await publicEventWhere(req, slug),
        select: { id: true, name: true, slug: true, bannerImage: true, bannerImageMobile: true, surveyConfig: true, surveyIntroHtml: true },
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
        where: await publicEventWhere(req, slug),
        select: {
          id: true, name: true, slug: true, bannerImage: true, bannerImageMobile: true,
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
        event: { id: event.id, name: event.name, slug: event.slug, bannerImage: event.bannerImage, bannerImageMobile: event.bannerImageMobile },
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

const shareRequestLinkSchema = z.object({
  share: z.string().min(1),
  email: z.string().email(),
});

/**
 * The one message the share endpoint ever returns on a well-formed request.
 *
 * Deliberately identical for "registered", "not registered" and "already
 * completed": the previous share path answered each differently, which made
 * the endpoint an **email-enumeration oracle** (review M1) — anyone could
 * probe whether a named physician attended an event. Password-reset flows
 * solve this the same way. The real attendee learns the outcome in their
 * inbox; a stranger learns nothing.
 */
const SHARE_LINK_GENERIC_MESSAGE =
  "If that email is registered for this event, we've sent your personal survey link to it. Please check your inbox (and your spam folder).";

/**
 * Shareable-link "email me my survey link" (review B1 fix, Aug 2026).
 *
 * ## What this used to do, and why it changed
 *
 * The share link is designed to be BROADCAST — a QR on the closing slide, a
 * WhatsApp blast, an email signature. It therefore carries **no per-person
 * identity**: one token for the whole event. The old handler accepted the
 * respondent's identity as a **typed email** and submitted the survey on that
 * basis, stamping `Registration.surveyCompletedAt`.
 *
 * That flag is not cosmetic — `certificates/auto-issue.ts` polls exactly it
 * (`surveyCompletedAt: { not: null }`) and mints a real, serialized, audited
 * CME certificate. So anyone who knew an attendee's email (routinely public
 * for medical faculty) could (1) issue a certificate in their name off garbage
 * answers, (2) **permanently lock the real attendee out** — `SurveyResponse.
 * registrationId` is `@unique`, the flag is set, and there is no organizer
 * "reset survey" — and (3) poison the accreditation dataset.
 *
 * The share link shipped when `surveyCompletedAt` was just a feedback flag;
 * certificate auto-issue later promoted that flag into a credential-issuing
 * trigger, and nobody re-asked who was allowed to set it. **Lesson: when a
 * field becomes a credential trigger, re-audit every writer of that field.**
 *
 * ## What it does now
 *
 * The share page is a GATEWAY, not a form. This endpoint takes the typed email
 * and, if it matches a registration, mints the **same per-registration token
 * the bulk-email invitation path mints** (`survey:{regId}`, 256-bit secret,
 * stored hashed, single-use, TTL-bounded) and emails it to that address. The
 * respondent then answers via the secure `?token=` path.
 *
 * Identity therefore rests on **possession of a secret delivered to the
 * registered mailbox** instead of on an unverified assertion. A stranger who
 * types a victim's address no longer forges anything — they just cause the
 * real attendee to receive their own link.
 *
 * The response is ALWAYS the same generic message (see
 * `SHARE_LINK_GENERIC_MESSAGE`), which also closes the enumeration oracle.
 */
async function handleShareRequestLink(
  req: Request,
  slug: string,
  body: unknown,
): Promise<NextResponse> {
  const parsed = shareRequestLinkSchema.safeParse(body);
  if (!parsed.success) {
    apiLogger.warn({ msg: "survey:share-link-request-invalid", slug, errors: parsed.error.flatten() });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { share: shareToken, email } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();
  const ip = getClientIp(req);

  // Per-IP limit. This endpoint now SENDS EMAIL on an unauthenticated request,
  // so it is an outbound-abuse surface (SES reputation), not just a DB one.
  //
  // Sized for the INTENDED use: the QR goes on the closing slide and a whole
  // hall scans it at once, all sharing one venue-NAT egress IP. 100/15 min
  // mirrors the public-register sustained per-IP limit, which exists for
  // exactly this shape. The tight bound that actually stops abuse is the
  // per-EMAIL limit below — a spray needs a different address every time.
  const ipLimit = checkRateLimit({
    key: `survey-share-link:ip:${ip}`,
    limit: 100,
    windowMs: 15 * 60 * 1000,
  });
  if (!ipLimit.allowed) {
    apiLogger.warn({
      msg: "survey:share-link-request-rate-limited-ip",
      slug,
      retryAfterSeconds: ipLimit.retryAfterSeconds,
    });
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } },
    );
  }

  const event = await db.event.findFirst({
    where: await publicEventWhere(req, slug),
    select: {
      id: true,
      name: true,
      slug: true,
      organizationId: true,
      surveyShareLink: true,
      surveyConfig: true,
      organization: { select: { name: true } },
    },
  });
  if (!event) {
    apiLogger.info({ msg: "survey:share-link-request-event-not-found", slug });
    return NextResponse.json({ error: "Survey not found" }, { status: 404 });
  }

  const valid = isShareLinkValid(event.surveyShareLink, shareToken);
  if (!valid.ok) {
    apiLogger.info({ msg: "survey:share-link-request-invalid-token", slug, reason: valid.reason });
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

  // No survey configured ⇒ nothing to send a link to. Event-level fact, so
  // reporting it leaks nothing about the typed email.
  if (readSurveyConfig(event.surveyConfig, event.id) === null) {
    apiLogger.info({ msg: "survey:share-link-request-no-survey", eventId: event.id });
    return NextResponse.json({ error: "Survey not found" }, { status: 404 });
  }

  // Per-EMAIL limit — stops someone using this endpoint to mail-bomb one
  // person. Keyed on the TYPED address (registered or not), so it reveals
  // nothing, and it deliberately returns the SAME generic 200 rather than a
  // 429: any status that varies with the email would re-open the oracle this
  // handler exists to close. The real owner already has recent links.
  const emailLimit = checkRateLimit({
    key: `survey-share-link:email:${normalizedEmail}`,
    limit: 3,
    windowMs: 60 * 60 * 1000,
  });
  if (!emailLimit.allowed) {
    apiLogger.warn({ msg: "survey:share-link-request-rate-limited-email", eventId: event.id });
    return NextResponse.json({ ok: true, message: SHARE_LINK_GENERIC_MESSAGE });
  }

  return await runWithTenant(event.organizationId, async () => {
    // Same email can map to multiple registrations in an event (multi-ticket /
    // re-registration): prefer one that hasn't completed. Scoped by the
    // tenant-resolved event id (the lookup above is host-scoped via
    // publicEventWhere) so there is no cross-event/tenant leak.
    const registrations = await db.registration.findMany({
      where: {
        eventId: event.id,
        status: { notIn: ["CANCELLED"] },
        attendee: { email: normalizedEmail },
      },
      select: SUBMIT_REGISTRATION_SELECT,
      orderBy: { createdAt: "desc" },
    });

    if (registrations.length === 0) {
      // Logged, but NOT surfaced — the generic response is the whole point.
      apiLogger.info({ msg: "survey:share-link-request-email-not-found", eventId: event.id });
      return NextResponse.json({ ok: true, message: SHARE_LINK_GENERIC_MESSAGE });
    }

    const target = registrations.find((r) => !r.surveyCompletedAt) ?? registrations[0];

    // An already-completed respondent still gets a link. The `?token=` path
    // renders a friendly "you've already completed this" state, so they learn
    // it in their own inbox — and the HTTP response stays uniform.
    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = hashVerificationToken(rawToken);
    try {
      // Identical mint to the bulk-email invitation path: drop any previous
      // token for this registration first so exactly ONE link is ever live.
      await db.verificationToken.deleteMany({
        where: { identifier: `${TOKEN_PREFIX}${target.id}` },
      });
      await db.verificationToken.create({
        data: {
          identifier: `${TOKEN_PREFIX}${target.id}`,
          token: hashedToken,
          expires: new Date(Date.now() + DEFAULT_SURVEY_EXPIRY_DAYS * DAY_MS),
        },
      });
    } catch (err) {
      apiLogger.error({
        msg: "survey:share-link-request-mint-failed",
        eventId: event.id,
        registrationId: target.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { error: "We couldn't send your survey link. Please try again." },
        { status: 500 },
      );
    }

    const template = await getEventTemplate(event.id, "survey-invitation");
    if (!template) {
      apiLogger.error({ msg: "survey:share-link-request-template-missing", eventId: event.id });
      return NextResponse.json(
        { error: "We couldn't send your survey link. Please try again." },
        { status: 500 },
      );
    }

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      "http://localhost:3000";
    const surveyLink = `${appUrl}/e/${event.slug}/survey?token=${rawToken}`;

    const rendered = renderAndWrap(
      template,
      {
        firstName: target.attendee.firstName,
        eventName: event.name,
        surveyLink,
        // Self-service request — there is no organizer composing a note.
        personalMessage: "",
        organizerName: template.branding.emailFromName || event.organization?.name || event.name,
      },
      template.branding,
    );

    const sent = await sendEmail({
      to: [{ email: normalizedEmail }],
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
      from: brandingFrom(template.branding),
      // Never CC the recipient onto their own email.
      cc: brandingCc(template.branding, [{ email: normalizedEmail }]),
      logContext: {
        organizationId: event.organizationId,
        eventId: event.id,
        entityType: "REGISTRATION",
        entityId: target.id,
        templateSlug: "survey-invitation",
      },
    });

    if (!sent.success) {
      apiLogger.error({
        msg: "survey:share-link-request-send-failed",
        eventId: event.id,
        registrationId: target.id,
        error: sent.error,
      });
      return NextResponse.json(
        { error: "We couldn't send your survey link. Please try again." },
        { status: 500 },
      );
    }

    apiLogger.info({
      msg: "survey:share-link-request-sent",
      eventId: event.id,
      registrationId: target.id,
      alreadyCompleted: Boolean(target.surveyCompletedAt),
    });
    return NextResponse.json({ ok: true, message: SHARE_LINK_GENERIC_MESSAGE });
  });
}

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

    // ── Shareable-link: request YOUR link by email (B1 fix) ──
    // Detected by the `share` field. This NO LONGER submits a survey — it
    // emails the requester their per-registration `?token=` link. A typed
    // email is an assertion, not proof, and `surveyCompletedAt` mints a CME
    // certificate; see handleShareRequestLink for the full rationale.
    //
    // Dispatched BEFORE the submit rate limit below, and carries its own
    // (room-scale per-IP + tight per-email): the share link is the QR on the
    // closing slide, so a whole hall requests links from ONE venue-NAT egress
    // IP within minutes. The submit limit is calibrated for the opposite shape
    // — one submit per person — and would cut the room off after 10. That is
    // the same venue-WiFi failure the ipHash dedup was removed for (review H1).
    if (typeof (body as { share?: unknown }).share === "string") {
      stage = "share-request-link";
      return await handleShareRequestLink(req, slug, body);
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

    // Shared finalizer — single-use token path deletes the token.
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
