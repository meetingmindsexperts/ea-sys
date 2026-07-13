/**
 * Deferred survey thank-you sweep — sends ONE post-survey email per attendee,
 * carrying their auto-issued certificate PDF(s) when ready.
 *
 * WHY DEFERRED: the thank-you used to fire inline the instant the survey was
 * submitted — but the certificate PDF is rendered ASYNCHRONOUSLY by the
 * auto-issue pipeline seconds-to-minutes later. You can't attach a file that
 * doesn't exist yet. So we hold the thank-you until the cert is rendered, then
 * send them together as a single email (product decision 2026-07-08).
 *
 * Runs each cert-issue tick, BEFORE `tickAllRuns`, so it can suppress the
 * separate cert cover email:
 *   - candidates = survey completers NOT yet thanked (no SENT `survey-thankyou`
 *     EmailLog row — that row IS the idempotency marker, so no schema change)
 *   - a cert still rendering AND < FALLBACK_MS since completion → DEFER
 *   - otherwise send the thank-you with any READY cert PDFs attached, and set
 *     `emailedAt` on those auto-run items so `tickAllRuns`' send phase skips
 *     them (→ no duplicate cover email)
 *   - a person with no eligible cert (or once the fallback elapses) gets the
 *     PLAIN thank-you. If a cert happens to render AFTER we sent plain, its
 *     auto-run item was never suppressed, so it still ships via the normal
 *     cover email — nobody loses their cert.
 *
 * Scans only the last SCAN_WINDOW so historical (already-thanked) rows don't
 * clog the batch. Failure-isolated per registration.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  brandingCc,
  brandingFrom,
  getDefaultTemplate,
  getEventTemplate,
  renderAndWrap,
  sendEmail,
  type EmailBranding,
} from "@/lib/email";
import { loadCertificatePdfBytes } from "./pdf-loader";

// Hold an eligible-but-not-yet-rendered cert's thank-you at most this long,
// then send the plain thank-you as a fallback so nobody gets nothing. Chosen
// by the owner (2026-07-08); certs normally render within a couple of ticks.
export const THANKYOU_FALLBACK_MS = 15 * 60 * 1000;

// Only look at recently-completed surveys. Post-deploy every completion is
// worker-driven (unthanked until this sweep), so nothing clogs; pre-deploy
// completions were already thanked inline (they carry a SENT EmailLog row and
// are excluded). 24h comfortably covers a worker outage + the fallback window.
const SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;

const SWEEP_BATCH_SIZE = 100;
const THANKYOU_SLUG = "survey-thankyou";

export type ThankYouAction = "defer" | "send-with-cert" | "send-plain";

/**
 * Pure decision — no DB. Given the recipient's cert state + how long ago they
 * finished the survey, decide whether to hold the thank-you, send it with the
 * cert, or send it plain. Unit-tested.
 */
export function decideThankYouDelivery(input: {
  /** Has the auto-issue sweep resolved this registration yet? */
  certChecked: boolean;
  /** Auto-issue cert items still rendering (renderedAt null). */
  pendingCerts: number;
  /** Auto-issued certs ready to attach (pdfUrl set). */
  readyCerts: number;
  elapsedMs: number;
  fallbackMs: number;
}): ThankYouAction {
  const { certChecked, pendingCerts, readyCerts, elapsedMs, fallbackMs } = input;
  // A cert is mid-render → wait for it (up to the fallback), so we can attach it.
  if (pendingCerts > 0 && elapsedMs < fallbackMs) return "defer";
  // Something is ready → send it now (attach whatever's rendered).
  if (readyCerts > 0) return "send-with-cert";
  // Eligibility not yet determined → wait briefly for the auto-issue sweep.
  if (!certChecked && elapsedMs < fallbackMs) return "defer";
  // Not eligible, or fallback elapsed with nothing ready → plain thank-you.
  return "send-plain";
}

export interface SurveyThankYouSweepResult {
  scanned: number;
  sent: number;
  withCert: number;
  plain: number;
  deferred: number;
  skippedNoEmail: number;
}

const CANDIDATE_SELECT = {
  id: true,
  eventId: true,
  surveyCompletedAt: true,
  certAutoIssueCheckedAt: true,
  attendee: { select: { firstName: true, email: true } },
  event: {
    select: {
      name: true,
      organizationId: true,
      emailHeaderImage: true,
      emailFooterImage: true,
      emailFooterHtml: true,
      emailFromAddress: true,
      emailFromName: true,
      emailCcAddresses: true,
    },
  },
} satisfies Prisma.RegistrationSelect;

type CandidateReg = Prisma.RegistrationGetPayload<{ select: typeof CANDIDATE_SELECT }>;

/** One sweep tick. Failure-isolated per registration. */
export async function runSurveyThankYouSweep(
  opts: { now?: Date; batchSize?: number } = {},
): Promise<SurveyThankYouSweepResult> {
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - SCAN_WINDOW_MS);

  // ── Idempotency, applied IN THE QUERY (review H3) ──
  //
  // This used to fetch `take: 100` ordered `surveyCompletedAt: desc` and only
  // THEN filter out already-thanked rows in memory. Once more than 100
  // completions existed in the window, the batch was permanently occupied by the
  // newest 100 — all of them already thanked after the first pass — so every
  // subsequent tick did ZERO work while the older, un-thanked registrations sat
  // below the slice, were never fetched again, and aged out of the window
  // unprocessed. On a 400-completion conference roughly 300 people silently
  // never received the thank-you (which is the vehicle carrying their
  // certificate).
  //
  // Two changes make progress guaranteed:
  //   1. exclude the already-thanked in the WHERE, so `take` only ever consumes
  //      rows that still need work;
  //   2. order OLDEST-first, so the queue drains FIFO and nobody starves.
  //
  // A SENT survey-thankyou EmailLog row is the "already thanked" marker. The
  // window bounds the list (thanks land minutes after completion, and completions
  // are themselves inside the window).
  const thankedRows = await db.emailLog.findMany({
    where: {
      entityType: "REGISTRATION",
      templateSlug: THANKYOU_SLUG,
      status: "SENT",
      createdAt: { gte: windowStart },
    },
    select: { entityId: true },
  });
  const thanked = new Set(
    thankedRows.map((r) => r.entityId).filter((id): id is string => !!id),
  );

  const candidates = await db.registration.findMany({
    where: {
      surveyCompletedAt: { not: null, gte: windowStart },
      ...(thanked.size ? { id: { notIn: [...thanked] } } : {}),
    },
    orderBy: { surveyCompletedAt: "asc" },
    take: opts.batchSize ?? SWEEP_BATCH_SIZE,
    select: CANDIDATE_SELECT,
  });

  const result: SurveyThankYouSweepResult = {
    scanned: candidates.length,
    sent: 0,
    withCert: 0,
    plain: 0,
    deferred: 0,
    skippedNoEmail: 0,
  };
  if (candidates.length === 0) return result;

  for (const reg of candidates) {
    if (thanked.has(reg.id)) continue;
    try {
      const outcome = await processOne(reg, now);
      switch (outcome) {
        case "deferred":
          result.deferred++;
          break;
        case "sent-with-cert":
          result.sent++;
          result.withCert++;
          break;
        case "sent-plain":
          result.sent++;
          result.plain++;
          break;
        case "no-email":
          result.skippedNoEmail++;
          break;
      }
    } catch (err) {
      apiLogger.warn({ err, msg: "survey-thankyou:failed", registrationId: reg.id, eventId: reg.eventId });
    }
  }

  apiLogger.info({ msg: "survey-thankyou:sweep", ...result });
  return result;
}

type ProcessOutcome = "deferred" | "sent-with-cert" | "sent-plain" | "no-email";

async function processOne(reg: CandidateReg, now: Date): Promise<ProcessOutcome> {
  const email = reg.attendee?.email;
  if (!email) {
    apiLogger.warn({ msg: "survey-thankyou:no-email", registrationId: reg.id, eventId: reg.eventId });
    return "no-email";
  }

  // Resolve the linked speaker (for APPRECIATION certs): companion first, then
  // a same-event email match. Mirrors the resolution in auto-issue.ts
  // (processRegistration) — kept minimal here to avoid touching the live path.
  let speakerId: string | null = null;
  const companion = await db.speaker.findFirst({
    where: { sourceRegistrationId: reg.id },
    select: { id: true },
  });
  speakerId = companion?.id ?? null;
  if (!speakerId) {
    const byEmail = await db.speaker.findFirst({
      where: { eventId: reg.eventId, email },
      select: { id: true },
    });
    speakerId = byEmail?.id ?? null;
  }

  const recipientOr = [
    { registrationId: reg.id },
    ...(speakerId ? [{ speakerId }] : []),
  ];

  // Auto-issued certs ready to attach (issuedByUserId null = survey-auto; not
  // manual). pdfUrl set = rendered + stored.
  const readyCerts = await db.issuedCertificate.findMany({
    where: { eventId: reg.eventId, issuedByUserId: null, pdfUrl: { not: null }, OR: recipientOr },
    select: { id: true, serial: true, pdfUrl: true },
  });

  // Auto-issue cert items still rendering (not yet ready to attach).
  const pendingCerts = await db.certificateIssueRunItem.count({
    where: {
      run: { autoIssue: true, eventId: reg.eventId },
      OR: recipientOr,
      renderedAt: null,
      emailedAt: null,
    },
  });

  const elapsedMs = now.getTime() - (reg.surveyCompletedAt?.getTime() ?? now.getTime());
  const action = decideThankYouDelivery({
    certChecked: reg.certAutoIssueCheckedAt != null,
    pendingCerts,
    readyCerts: readyCerts.length,
    elapsedMs,
    fallbackMs: THANKYOU_FALLBACK_MS,
  });

  if (action === "defer") return "deferred";

  // Build attachments (only for send-with-cert). Per-cert load failure is
  // non-fatal — send with whatever loaded rather than block the thank-you.
  const attachments: { name: string; content: string; contentType: string }[] = [];
  const deliveredCertIds: string[] = [];
  if (action === "send-with-cert") {
    for (const cert of readyCerts) {
      try {
        const bytes = await loadCertificatePdfBytes(cert.pdfUrl!, {
          eventId: reg.eventId,
          certificateId: cert.id,
        });
        attachments.push({ name: `${cert.serial}.pdf`, content: bytes.toString("base64"), contentType: "application/pdf" });
        deliveredCertIds.push(cert.id);
      } catch (err) {
        apiLogger.warn({ err, msg: "survey-thankyou:cert-load-failed", certificateId: cert.id, registrationId: reg.id });
      }
    }
  }

  await sendThankYouEmail(reg, email, attachments);

  // Suppress the separate cover email for the certs we actually delivered:
  // mark their auto-run items emailed so tickAllRuns' send phase skips them.
  if (deliveredCertIds.length > 0) {
    await suppressCoverEmails(reg.eventId, deliveredCertIds, now);
  }

  return attachments.length > 0 ? "sent-with-cert" : "sent-plain";
}

async function sendThankYouEmail(
  reg: CandidateReg,
  email: string,
  attachments: { name: string; content: string; contentType: string }[],
): Promise<void> {
  const dbTemplate = await getEventTemplate(reg.eventId, THANKYOU_SLUG);
  const fallback = getDefaultTemplate(THANKYOU_SLUG);
  const tpl = dbTemplate ?? fallback;
  if (!tpl) {
    apiLogger.error({ msg: "survey-thankyou:template-missing", eventId: reg.eventId, registrationId: reg.id });
    throw new Error("survey-thankyou template missing");
  }
  const branding: EmailBranding = dbTemplate?.branding ?? {
    eventName: reg.event.name,
    emailHeaderImage: reg.event.emailHeaderImage,
    emailFooterImage: reg.event.emailFooterImage,
    emailFooterHtml: reg.event.emailFooterHtml,
    emailFromAddress: reg.event.emailFromAddress,
    emailFromName: reg.event.emailFromName,
    emailCcAddresses: reg.event.emailCcAddresses,
  };
  const vars: Record<string, string | number | undefined> = {
    firstName: reg.attendee?.firstName ?? "there",
    lastName: "",
    eventName: reg.event.name,
  };
  const rendered = renderAndWrap(tpl, vars, branding);

  const result = await sendEmail({
    to: [{ email, name: reg.attendee?.firstName ?? undefined }],
    cc: brandingCc(branding, [{ email }]),
    from: brandingFrom(branding),
    subject: rendered.subject,
    htmlContent: rendered.htmlContent,
    textContent: rendered.textContent,
    attachments: attachments.length ? attachments : undefined,
    emailType: "survey_thankyou",
    stream: "transactional",
    logContext: {
      organizationId: reg.event.organizationId,
      eventId: reg.eventId,
      entityType: "REGISTRATION",
      entityId: reg.id,
      templateSlug: THANKYOU_SLUG,
    },
  });
  if (!result.success) {
    // sendEmail already wrote a FAILED EmailLog row; leaving no SENT row means
    // the next sweep tick retries this registration (bounded by SCAN_WINDOW).
    throw new Error(result.error ?? "thank-you send failed");
  }
}

async function suppressCoverEmails(eventId: string, certIds: string[], now: Date): Promise<void> {
  const items = await db.certificateIssueRunItem.findMany({
    where: {
      run: { autoIssue: true, eventId },
      issuedCertificateId: { in: certIds },
      emailedAt: null,
    },
    select: { id: true, runId: true },
  });
  for (const item of items) {
    // Mark delivered-via-thankyou so the cert worker's send phase skips it and
    // the run can complete without a duplicate cover email.
    await db.certificateIssueRunItem.update({ where: { id: item.id }, data: { emailedAt: now } });
    await db.certificateIssueRun.update({ where: { id: item.runId }, data: { emailedCount: { increment: 1 } } });
  }
}
