/**
 * Certificate issue-run worker — drives the two-phase pipeline:
 *
 *   PENDING        operator just created the run; cron picks it up next
 *                  tick and transitions to RENDERING
 *   RENDERING      cron drains items in batches of RENDER_BATCH_SIZE
 *                  per tick. For each: render PDF → upload to storage →
 *                  insert IssuedCertificate (catches dup) → link the
 *                  cert id to the run item. When all items have
 *                  renderedAt set, transitions to AWAITING_REVIEW.
 *   AWAITING_REVIEW  cron does nothing. Waiting for operator to click
 *                  "Send emails now" in the UI, which transitions
 *                  AWAITING_REVIEW → SENDING.
 *   SENDING        cron drains items in batches of EMAIL_BATCH_SIZE
 *                  per tick. For each: send email with PDF attachment
 *                  (via the existing email pipeline). When all items
 *                  have emailedAt set, transitions to COMPLETED.
 *   COMPLETED / FAILED / CANCELLED  terminal — cron ignores.
 *
 * Stall recovery — cron also reclaims runs whose status is RENDERING
 * or SENDING with lastTickAt older than STALL_THRESHOLD_MS (default
 * 10 min). Such runs get nudged back to the previous valid state
 * (RENDERING → PENDING, SENDING → AWAITING_REVIEW) so the next tick
 * starts them over. The per-item progress is preserved (renderedAt /
 * emailedAt aren't cleared), so we don't re-render or re-email
 * already-completed items.
 *
 * Idempotency — every IssuedCertificate insert relies on the
 * @@unique([eventId, type, registrationId|speakerId]) constraint. If
 * a concurrent run or replay tries to insert a dup, the unique
 * violation is caught and the item is marked as already-issued
 * (renderedAt set, but we link to the existing cert row instead of a
 * fresh insert).
 */

import { Prisma } from "@prisma/client";
import type { CertificateType } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { renderCertificate } from "./render";
import { uploadCertificatePdf } from "@/lib/storage";
import { loadCertificatePdfBytes } from "./pdf-loader";
import { escapeHtml } from "@/lib/html";
import { sendEmail, wrapWithBranding, inlineCss, brandingFrom, type EmailBranding } from "@/lib/email";
import {
  resolveCoverEmailTokens,
  type CoverEmailTokenContext,
} from "./email-tokens-resolver";
import {
  SYSTEM_DEFAULT_SUBJECT,
  defaultBodyForCategory,
} from "./email-tokens";
import type { CertificateData, CertificateTemplate } from "./types";
import {
  loadEventContext,
  loadRecipient,
  allocateSerial,
  loadPosterAbstractTitle,
  type EventContext,
} from "./cert-context";
import { reRenderAndResendCert, type DeliverContext } from "./deliver";

// Tunables — the math: at 50 renders/tick × 50ms each = 2.5s per tick
// for the render phase (well under any HTTP timeout). For email at the
// SES 14/sec hard cap, 25/tick = ~1.8s wall-clock.
const RENDER_BATCH_SIZE = 50;
const EMAIL_BATCH_SIZE = 25;
const STALL_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const MAX_RECORDED_ERRORS = 100;

/**
 * Process every actionable run for every event. Cron entry point calls
 * this. Returns a summary for the cron's structured log line.
 */
export async function tickAllRuns(): Promise<{
  reclaimed: number;
  rendered: number;
  emailed: number;
  completed: number;
  failed: number;
}> {
  // 1. Reclaim stalled runs first so they're picked up this tick.
  const reclaimed = await reclaimStalledRuns();

  // 2. Pull all non-terminal runs ordered by triggeredAt so the oldest
  //    finishes first. Bounded list (rarely > 10 active across all
  //    events) so no need to limit/paginate.
  const runs = await db.certificateIssueRun.findMany({
    where: { status: { in: ["PENDING", "RENDERING", "SENDING"] } },
    orderBy: { triggeredAt: "asc" },
    take: 20,
  });

  let rendered = 0;
  let emailed = 0;
  let completed = 0;
  let failed = 0;

  for (const run of runs) {
    try {
      const result = await processRun(run.id);
      rendered += result.renderedThisTick;
      emailed += result.emailedThisTick;
      if (result.transitionedTo === "COMPLETED") completed++;
      if (result.transitionedTo === "FAILED") failed++;
    } catch (e) {
      apiLogger.error({
        err: e,
        msg: "cert-issue-worker:run-failed",
        runId: run.id,
      });
      failed++;
    }
  }

  return { reclaimed, rendered, emailed, completed, failed };
}

/** Reclaim runs whose RENDERING/SENDING lastTickAt is older than the
 *  stall threshold — push them back to the prior valid state so the
 *  next tick re-engages. Per-item progress is preserved.
 *
 *  Exported for unit testing the autoIssue-aware SENDING branch. */
export async function reclaimStalledRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - STALL_THRESHOLD_MS);
  const renderingStalls = await db.certificateIssueRun.updateMany({
    where: { status: "RENDERING", lastTickAt: { lt: cutoff } },
    data: { status: "PENDING" },
  });
  // MANUAL issue SENDING stalls → bounce to AWAITING_REVIEW so an operator
  // re-confirms before the rest of the batch goes out (the human-review gate is
  // the point). Excludes auto AND reissue runs — neither has that gate.
  const sendingStalls = await db.certificateIssueRun.updateMany({
    where: { status: "SENDING", lastTickAt: { lt: cutoff }, autoIssue: false, reissue: false },
    data: { status: "AWAITING_REVIEW" },
  });
  // AUTO (survey-gated) + REISSUE (bulk resend) SENDING stalls have NO review
  // gate. Demoting them to AWAITING_REVIEW would strand them (auto: the reg is
  // already stamped so the sweep won't re-enqueue; reissue: there's no render
  // phase to re-run). Keep them in SENDING and just refresh lastTickAt so the
  // next tick re-drains the remaining emailedAt-null items — the send/reissue
  // phase is re-entrant and per-item failures are already marked + excluded.
  const autoSendingStalls = await db.certificateIssueRun.updateMany({
    where: {
      status: "SENDING",
      lastTickAt: { lt: cutoff },
      OR: [{ autoIssue: true }, { reissue: true }],
    },
    data: { lastTickAt: new Date() },
  });
  const total = renderingStalls.count + sendingStalls.count + autoSendingStalls.count;
  if (total > 0) {
    apiLogger.warn({
      msg: "cert-issue-worker:reclaimed-stalled-runs",
      renderingReclaimed: renderingStalls.count,
      sendingReclaimed: sendingStalls.count,
      autoSendingRefreshed: autoSendingStalls.count,
      cutoff,
    });
  }
  return total;
}

interface RunTickResult {
  renderedThisTick: number;
  emailedThisTick: number;
  transitionedTo: "AWAITING_REVIEW" | "COMPLETED" | "FAILED" | null;
}

/** Process one run for one cron tick. */
async function processRun(runId: string): Promise<RunTickResult> {
  const run = await db.certificateIssueRun.findUnique({
    where: { id: runId },
    select: {
      id: true, eventId: true, type: true, status: true,
      certificateTemplateId: true, autoIssue: true, reissue: true,
      triggeredByUserId: true,
      totalCount: true, renderedCount: true, emailedCount: true, failedCount: true,
      rendererStartedAt: true, errors: true,
    },
  });
  if (!run) {
    return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: null };
  }

  // Reissue runs (bulk "resend latest to everyone") skip the render +
  // AWAITING_REVIEW gates entirely: PENDING → SENDING, then each item is
  // drained via reRenderAndResendCert (re-render the EXISTING cert from the
  // current template + resend). Kept fully separate from the issue path below
  // so that path is byte-for-byte unchanged.
  if (run.reissue) {
    if (run.status === "PENDING") {
      const claim = await db.certificateIssueRun.updateMany({
        where: { id: runId, status: "PENDING" },
        data: {
          status: "SENDING",
          rendererStartedAt: run.rendererStartedAt ?? new Date(),
          emailerStartedAt: new Date(),
          lastTickAt: new Date(),
        },
      });
      if (claim.count === 0) {
        return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: null };
      }
    }
    if (run.status === "SENDING" || run.status === "PENDING") {
      return processReissuePhase(runId, run.eventId, run.triggeredByUserId);
    }
    return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: null };
  }

  // PENDING → RENDERING (atomic claim — only one cron can grab a
  // PENDING run; second cron loses the race + skips). Set lastTickAt
  // so the stall detector doesn't fire on a freshly-claimed run.
  if (run.status === "PENDING") {
    const claim = await db.certificateIssueRun.updateMany({
      where: { id: runId, status: "PENDING" },
      data: {
        status: "RENDERING",
        rendererStartedAt: run.rendererStartedAt ?? new Date(),
        lastTickAt: new Date(),
      },
    });
    if (claim.count === 0) {
      // Another cron got there first; bail and let them process it.
      return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: null };
    }
  }

  if (run.status === "RENDERING" || run.status === "PENDING") {
    return processRenderPhase(runId, run.eventId, run.type, run.certificateTemplateId, run.autoIssue);
  }
  if (run.status === "SENDING") {
    return processSendPhase(runId, run.eventId);
  }
  return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: null };
}

// ── RENDER phase ─────────────────────────────────────────────────────────────

async function processRenderPhase(
  runId: string,
  eventId: string,
  type: CertificateType,
  certificateTemplateId: string | null,
  autoIssue: boolean,
): Promise<RunTickResult> {
  // Pull next batch of items needing render.
  const items = await db.certificateIssueRunItem.findMany({
    where: { runId, renderedAt: null },
    take: RENDER_BATCH_SIZE,
  });

  if (items.length === 0) {
    // Render phase complete. Manual runs stop at AWAITING_REVIEW (the
    // operator preview gate); survey-gated auto runs SKIP that gate and
    // go straight to SENDING so the cert lands in the inbox without a
    // human click (Phase 2 product decision).
    const nextStatus = autoIssue ? "SENDING" : "AWAITING_REVIEW";
    await db.certificateIssueRun.update({
      where: { id: runId },
      data: {
        status: nextStatus,
        rendererFinishedAt: new Date(),
        ...(autoIssue ? { emailerStartedAt: new Date() } : {}),
        lastTickAt: new Date(),
      },
    });
    apiLogger.info({ msg: "cert-issue-worker:render-phase-complete", runId, autoIssue, nextStatus });
    return {
      renderedThisTick: 0,
      emailedThisTick: 0,
      transitionedTo: autoIssue ? null : "AWAITING_REVIEW",
    };
  }

  // Heartbeat — bump lastTickAt at the start of this tick's work so a
  // crash mid-batch leaves a marker for the stall detector.
  await db.certificateIssueRun.update({
    where: { id: runId },
    data: { lastTickAt: new Date() },
  });

  // Load event + template + recipients in one go; renderer doesn't
  // touch the DB so we can pass plain objects.
  const event = await loadEventContext(eventId);
  if (!event) {
    await failRun(runId, "Event not found");
    return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: "FAILED" };
  }

  // Load the specific template row this run was bound to. v3 multi-
  // template model: runs created post-2026-06-02 always carry a
  // certificateTemplateId; legacy runs (none exist in prod yet) fall
  // back to an empty template + the placeholder PDF the renderer
  // produces.
  let template: CertificateTemplate = {};
  if (certificateTemplateId) {
    const tmpl = await db.certificateTemplate.findUnique({
      where: { id: certificateTemplateId },
      select: { backgroundPdfUrl: true, textBoxes: true, role: true, cmeHours: true },
    });
    if (tmpl) {
      template = {
        backgroundPdfUrl: tmpl.backgroundPdfUrl,
        // Cast via unknown — Prisma's JsonValue can't structurally
        // narrow to CertificateTextBox[]; the column is Zod-validated
        // at write time so the cast is safe.
        textBoxes: tmpl.textBoxes as unknown as CertificateTemplate["textBoxes"],
        role: tmpl.role,
        cmeHours: tmpl.cmeHours == null ? null : Number(tmpl.cmeHours),
      };
    } else {
      // Template was deleted between run-create and render-tick. The
      // FK cascade is SetNull (preserves audit-trail integrity), so
      // this run row still exists but has no template to render from.
      // FAIL the run hard rather than silently producing placeholder
      // PDFs and shipping them to 300+ attendees — per review H4.
      apiLogger.error({
        msg: "cert-issue-worker:template-deleted-mid-run",
        runId,
        eventId,
        certificateTemplateId,
        remainingItems: items.length,
      });
      await failRun(
        runId,
        `Template ${certificateTemplateId} was deleted while this run was in progress. Re-create the template + start a new run.`,
      );
      return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: "FAILED" };
    }
  }

  let rendered = 0;
  for (const item of items) {
    try {
      const certId = await renderAndStoreItem({
        item,
        runId,
        eventId,
        type,
        certificateTemplateId,
        event,
        template,
      });
      await db.certificateIssueRunItem.update({
        where: { id: item.id },
        data: { renderedAt: new Date(), issuedCertificateId: certId },
      });
      await db.certificateIssueRun.update({
        where: { id: runId },
        data: { renderedCount: { increment: 1 } },
      });
      rendered++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await markItemFailed(runId, item.id, "render", message);
      apiLogger.warn({
        err: e,
        msg: "cert-issue-worker:render-failed",
        runId,
        itemId: item.id,
        recipientName: item.recipientName,
      });
    }
  }
  return { renderedThisTick: rendered, emailedThisTick: 0, transitionedTo: null };
}

/** Render one cert PDF + store it + insert IssuedCertificate. Returns
 *  the certificate id. Handles the "already exists" case by linking to
 *  the existing cert instead of inserting a dup. */
async function renderAndStoreItem(args: {
  item: {
    id: string;
    registrationId: string | null;
    speakerId: string | null;
    recipientName: string;
    recipientEmail: string | null;
  };
  runId: string;
  eventId: string;
  type: CertificateType;
  certificateTemplateId: string | null;
  event: EventContext;
  template: CertificateTemplate;
}): Promise<string> {
  const { item, eventId, type, certificateTemplateId, event, template } = args;

  // Resolve recipient details (title, email, affiliation) for the
  // recipientSnapshot + render data. We have recipientName + email
  // from the run item but the renderer needs full structured data.
  const recipientData = await loadRecipient(item.registrationId, item.speakerId);
  if (!recipientData) {
    throw new Error(`Recipient not found (registrationId=${item.registrationId}, speakerId=${item.speakerId})`);
  }

  // Build cert-type-specific extras. Post enum collapse (2 types, 2026-06-02)
  // APPRECIATION rolls up the old PRESENTER / POSTER / CME buckets:
  //   - poster authors carry the abstract title in extras for future
  //     use (not currently wired into a {{token}} — `resolveTokens` in
  //     template.ts owns the token map and doesn't expose abstractTitle
  //     today; tracked as M12 in the audit, add `{{abstractTitle}}` to
  //     `resolveTokens` if/when an organizer asks for it);
  //   - everyone else gets an empty extras payload so the template's
  //     tokens drive the visible variation.
  let extras: CertificateData["extras"];
  if (type === "APPRECIATION" && item.speakerId) {
    const abstractTitle = await loadPosterAbstractTitle(item.speakerId, eventId);
    extras = { type: "APPRECIATION", abstractTitle };
  } else {
    extras = { type: "ATTENDANCE" };
  }

  const certData: CertificateData = {
    type,
    serial: await allocateSerial(eventId, type),
    issuedAt: new Date(),
    recipient: recipientData,
    event,
    extras,
    template,
  };

  const pdfBuffer = await renderCertificate(certData);

  // Insert the IssuedCertificate row, catching the unique-constraint
  // violation if a concurrent run/path already inserted one for this
  // (event, type, recipient). On dup, fetch the existing row + reuse
  // its id — preserves the original serial + audit trail.
  let certId: string;
  try {
    const cert = await db.issuedCertificate.create({
      data: {
        eventId,
        registrationId: item.registrationId,
        speakerId: item.speakerId,
        type,
        certificateTemplateId,
        serial: certData.serial,
        issuedByUserId: await getRunTriggerUserId(args.runId),
        recipientSnapshot: recipientData as unknown as Prisma.InputJsonValue,
        // Snapshot CME hours on the cert row regardless of type — the
        // CME-as-its-own-type concept was collapsed on 2026-06-02 and
        // both ATTENDANCE and APPRECIATION certs may render {{cmeHours}}
        // when the event is CME-accredited. Per-template hours (organizer-
        // entered) override the event-level value when set.
        cmeHoursSnapshot: template.cmeHours ?? event.cmeHours ?? null,
      },
      select: { id: true },
    });
    certId = cert.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Dup — find the existing cert for this (event, TEMPLATE, recipient).
      // Per-template (was per-type) so two same-category templates for one
      // recipient resolve to the right existing row.
      const existing = await db.issuedCertificate.findFirst({
        where: {
          eventId,
          certificateTemplateId,
          ...(item.registrationId ? { registrationId: item.registrationId } : { speakerId: item.speakerId }),
        },
        select: { id: true },
      });
      if (!existing) throw e;
      certId = existing.id;
      apiLogger.info({
        msg: "cert-issue-worker:dedupe-existing-cert",
        certId,
        runId: args.runId,
      });
    } else {
      throw e;
    }
  }

  // Upload PDF to storage, persist the URL on the cert row.
  const filename = `${certId}.pdf`;
  const pdfUrl = await uploadCertificatePdf(pdfBuffer, filename, eventId);
  await db.issuedCertificate.update({
    where: { id: certId },
    data: { pdfUrl },
  });
  return certId;
}

// ── SEND phase ──────────────────────────────────────────────────────────────

async function processSendPhase(
  runId: string,
  eventId: string,
): Promise<RunTickResult> {
  // Load the run row to read the snapshotted email subject + body the
  // operator confirmed at Issue time. Falls back to system defaults
  // when missing — covers legacy runs created before the email-
  // editor feature shipped.
  const runRow = await db.certificateIssueRun.findUnique({
    where: { id: runId },
    select: { type: true, emailSubject: true, emailBody: true },
  });
  if (!runRow) {
    apiLogger.error({ msg: "cert-issue-worker:send-run-not-found", runId });
    await failRun(runId, "Run row vanished mid-send");
    return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: "FAILED" };
  }

  // Owner org for the EmailLog row's organizationId column — without this
  // the cert delivery row is written as org-null and gets hidden from the
  // EmailLogCard on the registration/speaker detail sheet (see
  // src/lib/email-log.ts history note on the missing-organizationId bug).
  const eventForOrg = await db.event.findUnique({
    where: { id: eventId },
    select: { organizationId: true },
  });
  const organizationIdForLog = eventForOrg?.organizationId ?? null;
  const emailSubjectTemplate =
    runRow.emailSubject?.trim().length ? runRow.emailSubject : SYSTEM_DEFAULT_SUBJECT;
  const emailBodyTemplate =
    runRow.emailBody?.trim().length ? runRow.emailBody : defaultBodyForCategory(runRow.type);

  const items = await db.certificateIssueRunItem.findMany({
    where: {
      runId,
      issuedCertificateId: { not: null },
      emailedAt: null,
    },
    take: EMAIL_BATCH_SIZE,
  });

  if (items.length === 0) {
    await db.certificateIssueRun.update({
      where: { id: runId },
      data: {
        status: "COMPLETED",
        emailerFinishedAt: new Date(),
        lastTickAt: new Date(),
      },
    });
    apiLogger.info({ msg: "cert-issue-worker:send-phase-complete", runId });
    return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: "COMPLETED" };
  }

  await db.certificateIssueRun.update({
    where: { id: runId },
    data: { lastTickAt: new Date() },
  });

  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      id: true, name: true, slug: true,
      startDate: true, endDate: true,
      venue: true, city: true, country: true,
      emailFromAddress: true, emailFromName: true,
      emailHeaderImage: true, emailFooterImage: true, emailFooterHtml: true,
      organization: { select: { name: true, logo: true } },
    },
  });
  if (!event) {
    await failRun(runId, "Event not found");
    return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: "FAILED" };
  }

  let emailed = 0;
  for (const item of items) {
    if (!item.recipientEmail) {
      await markItemFailed(runId, item.id, "email", "Recipient has no email address");
      continue;
    }
    try {
      // Fetch the rendered PDF bytes (from local fs OR Supabase URL).
      // For local: read directly from public/. For Supabase: fetch via
      // the public URL. Either path returns a Buffer.
      const cert = await db.issuedCertificate.findUnique({
        where: { id: item.issuedCertificateId! },
        select: { pdfUrl: true, serial: true },
      });
      if (!cert?.pdfUrl) {
        throw new Error("Cert pdfUrl missing — render phase didn't persist it");
      }
      const pdfBuffer = await loadCertificatePdfBytes(cert.pdfUrl);

      // Per-recipient token resolution. The run row carries the
      // organizer-confirmed subject + body; tokens (recipientName,
      // certificateSerial, abstractTitle, etc.) get substituted per
      // recipient. Resolver HTML-escapes user-controlled values for
      // the body's text token slots (B2 fix from the audit), and
      // logs unknown tokens to /logs at warn level.
      const tokenCtx: CoverEmailTokenContext = {
        recipientName: item.recipientName,
        eventName: event.name,
        eventStartDate: event.startDate,
        eventEndDate: event.endDate,
        venue: event.venue,
        city: event.city,
        country: event.country,
        organizationName: event.organization.name,
        certificateType: runRow.type,
        certificateSerial: cert.serial,
        speakerId: item.speakerId,
        eventId,
      };
      // The HTML body is organizer-authored Tiptap output. Tokens are
      // interpolated into a USER-LEVEL HTML document so the resolver
      // escapes the dynamic values; the static HTML around the tokens
      // is trusted (operator wrote it).
      const escapedTokenCtx: CoverEmailTokenContext = {
        ...tokenCtx,
        recipientName: escapeHtml(tokenCtx.recipientName),
        eventName: escapeHtml(tokenCtx.eventName),
        organizationName: escapeHtml(tokenCtx.organizationName),
        venue: tokenCtx.venue ? escapeHtml(tokenCtx.venue) : tokenCtx.venue,
        city: tokenCtx.city ? escapeHtml(tokenCtx.city) : tokenCtx.city,
        country: tokenCtx.country ? escapeHtml(tokenCtx.country) : tokenCtx.country,
        // Escape the resolver-internal abstractTitle too (caller can't
        // reach it — it's DB-fetched inside resolveCoverEmailTokens).
        escapeDynamic: true,
      };
      const subject = (
        await resolveCoverEmailTokens(emailSubjectTemplate, tokenCtx)
      ).replace(/\s+/g, " ").trim();
      const bodyHtml = await resolveCoverEmailTokens(emailBodyTemplate, escapedTokenCtx);
      const bodyText = await resolveCoverEmailTokens(emailBodyTemplate, tokenCtx)
        .then((html) =>
          html
            .replace(/<\s*br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
        );

      // H1 fix: apply the same branding pipeline every other org email
      // uses — wrap the resolved body in the event's header image +
      // footer HTML + footer image, then inline CSS so Outlook etc.
      // render the styles. Pre this change the cert-delivery email
      // bypassed the pipeline entirely.
      const branding: EmailBranding = {
        emailHeaderImage: event.emailHeaderImage,
        emailFooterImage: event.emailFooterImage,
        emailFooterHtml: event.emailFooterHtml,
        emailFromAddress: event.emailFromAddress,
        emailFromName: event.emailFromName ?? event.organization.name,
        eventName: event.name,
      };
      const wrappedHtml = inlineCss(wrapWithBranding(bodyHtml, branding));

      const result = await sendEmail({
        to: [{ email: item.recipientEmail, name: item.recipientName }],
        subject,
        htmlContent: wrappedHtml,
        textContent: bodyText,
        from: brandingFrom(branding),
        attachments: [
          {
            name: `${cert.serial}.pdf`,
            content: pdfBuffer.toString("base64"),
            contentType: "application/pdf",
          },
        ],
        emailType: "certificate",
        logContext: {
          organizationId: organizationIdForLog,
          entityType: item.speakerId ? "SPEAKER" : "REGISTRATION",
          entityId: item.registrationId ?? item.speakerId ?? null,
          eventId,
          // templateSlug doubles as a discriminator on the EmailLogCard
          // — the card renders an amber "Certificate" pill when this
          // slug is present, so an organizer scanning Email History can
          // pick out cert sends at a glance without reading each subject.
          templateSlug: "certificate-delivery",
        },
      });
      if (!result.success) {
        throw new Error(result.error ?? "sendEmail returned no message id");
      }
      await db.certificateIssueRunItem.update({
        where: { id: item.id },
        data: { emailedAt: new Date() },
      });
      await db.certificateIssueRun.update({
        where: { id: runId },
        data: { emailedCount: { increment: 1 } },
      });
      emailed++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await markItemFailed(runId, item.id, "email", message);
      apiLogger.warn({
        err: e,
        msg: "cert-issue-worker:email-failed",
        runId,
        itemId: item.id,
        recipientEmail: item.recipientEmail,
      });
    }
  }
  return { renderedThisTick: 0, emailedThisTick: emailed, transitionedTo: null };
}

// ── REISSUE phase (bulk re-render + resend) ───────────────────────────────────

/** Drain a reissue run: each item points at an EXISTING cert; re-render it from
 *  the current template + resend via the shared reRenderAndResendCert (same
 *  logic as the single "Resend latest version" action — no duplication). */
async function processReissuePhase(
  runId: string,
  eventId: string,
  triggeredByUserId: string | null,
): Promise<RunTickResult> {
  const event = await db.event.findUnique({ where: { id: eventId }, select: { organizationId: true } });
  if (!event) {
    await failRun(runId, "Event not found");
    return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: "FAILED" };
  }

  const items = await db.certificateIssueRunItem.findMany({
    where: { runId, issuedCertificateId: { not: null }, emailedAt: null },
    take: EMAIL_BATCH_SIZE,
  });

  if (items.length === 0) {
    await db.certificateIssueRun.update({
      where: { id: runId },
      data: { status: "COMPLETED", emailerFinishedAt: new Date(), lastTickAt: new Date() },
    });
    apiLogger.info({ msg: "cert-issue-worker:reissue-phase-complete", runId });
    return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: "COMPLETED" };
  }

  await db.certificateIssueRun.update({ where: { id: runId }, data: { lastTickAt: new Date() } });

  const ctx: DeliverContext = {
    eventId,
    organizationId: event.organizationId,
    // Bulk reissue is always operator-triggered; fall back to null (not "")
    // defensively so the audit/issuedByUserId FKs stay valid if a null-triggered
    // reissue run ever exists.
    actorUserId: triggeredByUserId ?? null,
    source: "bulk",
  };

  let emailed = 0;
  for (const item of items) {
    try {
      const result = await reRenderAndResendCert(ctx, item.issuedCertificateId!);
      if (result.ok) {
        await db.certificateIssueRunItem.update({
          where: { id: item.id },
          data: { renderedAt: new Date(), emailedAt: new Date() },
        });
        await db.certificateIssueRun.update({
          where: { id: runId },
          data: { renderedCount: { increment: 1 }, emailedCount: { increment: 1 } },
        });
        emailed++;
      } else {
        await markItemFailed(runId, item.id, "email", `${result.code}: ${result.error}`);
        apiLogger.warn({ msg: "cert-issue-worker:reissue-item-failed", runId, itemId: item.id, code: result.code });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await markItemFailed(runId, item.id, "email", message);
      apiLogger.warn({ err: e, msg: "cert-issue-worker:reissue-item-error", runId, itemId: item.id });
    }
  }
  return { renderedThisTick: 0, emailedThisTick: emailed, transitionedTo: null };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getRunTriggerUserId(runId: string): Promise<string | null> {
  // Null for survey-gated auto-issue runs (no operator). The cert's
  // issuedByUserId column is nullable to carry that fact.
  const run = await db.certificateIssueRun.findUnique({
    where: { id: runId },
    select: { triggeredByUserId: true },
  });
  if (!run) throw new Error(`Run ${runId} not found while resolving triggeredByUserId`);
  return run.triggeredByUserId;
}

async function markItemFailed(
  runId: string,
  itemId: string,
  phase: "render" | "email",
  message: string,
) {
  // CRITICAL: set the phase timestamp (renderedAt for render-phase
  // failures, emailedAt for email-phase failures) so the next cron
  // tick's `where: { renderedAt: null }` / `where: { emailedAt: null }`
  // query EXCLUDES this item. Without this, permanently-broken items
  // (e.g. recipient has no email address, or render template is missing
  // a referenced asset) would re-enter every tick's batch and the run
  // would never reach COMPLETED — it would sit in RENDERING / SENDING
  // forever, eating cron cycles. The errorMessage is what marks the
  // item as failed; the timestamp marks it as "processed (with
  // failure)". Retry-failed flips both back.
  const now = new Date();
  const itemUpdate: Prisma.CertificateIssueRunItemUpdateInput = {
    errorPhase: phase,
    errorMessage: message.slice(0, 1000),
  };
  if (phase === "render") itemUpdate.renderedAt = now;
  if (phase === "email") itemUpdate.emailedAt = now;
  await db.certificateIssueRunItem.update({
    where: { id: itemId },
    data: itemUpdate,
  });
  // Append to run.errors JSON capped at MAX_RECORDED_ERRORS entries.
  const run = await db.certificateIssueRun.findUnique({
    where: { id: runId }, select: { errors: true },
  });
  const prev = Array.isArray(run?.errors) ? (run!.errors as unknown[]) : [];
  const next = [...prev, { itemId, phase, message: message.slice(0, 500), at: new Date().toISOString() }]
    .slice(-MAX_RECORDED_ERRORS);
  await db.certificateIssueRun.update({
    where: { id: runId },
    data: {
      errors: next as unknown as Prisma.InputJsonValue,
      failedCount: { increment: 1 },
    },
  });
}

async function failRun(runId: string, reason: string) {
  await db.certificateIssueRun.update({
    where: { id: runId },
    data: {
      status: "FAILED",
      errors: { fatal: reason } as unknown as Prisma.InputJsonValue,
      lastTickAt: new Date(),
    },
  });
}
