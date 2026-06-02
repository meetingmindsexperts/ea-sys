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
import { sendEmail } from "@/lib/email";
import type { CertificateData, CertificateTemplate, AccreditationEntry } from "./types";

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
 *  next tick re-engages. Per-item progress is preserved. */
async function reclaimStalledRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - STALL_THRESHOLD_MS);
  const renderingStalls = await db.certificateIssueRun.updateMany({
    where: { status: "RENDERING", lastTickAt: { lt: cutoff } },
    data: { status: "PENDING" },
  });
  const sendingStalls = await db.certificateIssueRun.updateMany({
    where: { status: "SENDING", lastTickAt: { lt: cutoff } },
    data: { status: "AWAITING_REVIEW" },
  });
  const total = renderingStalls.count + sendingStalls.count;
  if (total > 0) {
    apiLogger.warn({
      msg: "cert-issue-worker:reclaimed-stalled-runs",
      renderingReclaimed: renderingStalls.count,
      sendingReclaimed: sendingStalls.count,
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
      totalCount: true, renderedCount: true, emailedCount: true, failedCount: true,
      rendererStartedAt: true, errors: true,
    },
  });
  if (!run) {
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
    return processRenderPhase(runId, run.eventId, run.type);
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
): Promise<RunTickResult> {
  // Pull next batch of items needing render.
  const items = await db.certificateIssueRunItem.findMany({
    where: { runId, renderedAt: null },
    take: RENDER_BATCH_SIZE,
  });

  if (items.length === 0) {
    // Render phase complete — transition to AWAITING_REVIEW.
    await db.certificateIssueRun.update({
      where: { id: runId },
      data: {
        status: "AWAITING_REVIEW",
        rendererFinishedAt: new Date(),
        lastTickAt: new Date(),
      },
    });
    apiLogger.info({ msg: "cert-issue-worker:render-phase-complete", runId });
    return { renderedThisTick: 0, emailedThisTick: 0, transitionedTo: "AWAITING_REVIEW" };
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
  const template = readTemplateForType(event.settings, type);

  let rendered = 0;
  for (const item of items) {
    try {
      const certId = await renderAndStoreItem({
        item,
        runId,
        eventId,
        type,
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
  event: EventContext;
  template: CertificateTemplate;
}): Promise<string> {
  const { item, eventId, type, event, template } = args;

  // Resolve recipient details (title, email, affiliation) for the
  // recipientSnapshot + render data. We have recipientName + email
  // from the run item but the renderer needs full structured data.
  const recipientData = await loadRecipient(item.registrationId, item.speakerId);
  if (!recipientData) {
    throw new Error(`Recipient not found (registrationId=${item.registrationId}, speakerId=${item.speakerId})`);
  }

  // Build cert-type-specific extras. Post enum collapse (2 types, 2026-06-02)
  // APPRECIATION rolls up the old PRESENTER / POSTER / CME buckets:
  //   - poster authors carry the abstract title (rendered via a
  //     dedicated `{{abstractTitle}}` text box if the organizer adds one);
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
        serial: certData.serial,
        issuedByUserId: await getRunTriggerUserId(args.runId),
        recipientSnapshot: recipientData as unknown as Prisma.InputJsonValue,
        // Snapshot CME hours on the cert row regardless of type — the
        // CME-as-its-own-type concept was collapsed on 2026-06-02 and
        // both ATTENDANCE and APPRECIATION certs may render {{cmeHours}}
        // when the event is CME-accredited.
        cmeHoursSnapshot: event.cmeHours ?? null,
      },
      select: { id: true },
    });
    certId = cert.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Dup — find the existing cert for this (event, type, recipient).
      const existing = await db.issuedCertificate.findFirst({
        where: {
          eventId,
          type,
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
      id: true, name: true,
      emailFromAddress: true, emailFromName: true,
      organization: { select: { name: true } },
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
      const pdfBuffer = await loadPdfBytes(cert.pdfUrl);

      const result = await sendEmail({
        to: [{ email: item.recipientEmail, name: item.recipientName }],
        subject: `Your certificate — ${event.name}`,
        htmlContent: `<p>Dear ${item.recipientName},</p><p>Please find your certificate for <strong>${event.name}</strong> attached.</p><p>Best regards,<br>${event.organization.name}</p>`,
        textContent: `Dear ${item.recipientName},\n\nPlease find your certificate for ${event.name} attached.\n\nBest regards,\n${event.organization.name}`,
        from: event.emailFromAddress
          ? { email: event.emailFromAddress, name: event.emailFromName ?? event.organization.name }
          : undefined,
        attachments: [
          {
            name: `${cert.serial}.pdf`,
            content: pdfBuffer.toString("base64"),
            contentType: "application/pdf",
          },
        ],
        emailType: "certificate",
        logContext: {
          entityType: "REGISTRATION", // best-effort; speaker certs reuse the bucket
          entityId: item.registrationId ?? item.speakerId ?? null,
          eventId,
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

// ── Helpers ──────────────────────────────────────────────────────────────────

interface EventContext {
  name: string;
  startDate: Date;
  endDate: Date;
  venue: string | null;
  city: string | null;
  country: string | null;
  organizationName: string;
  organizationLogo: string | null;
  cmeHours: number | null;
  // Narrowed to AccreditationEntry so it satisfies the renderer's
  // CertificateEventContext shape (it expects the body field to be the
  // closed union, not a wide string).
  accreditations: AccreditationEntry[];
  settings: unknown;
}

async function loadEventContext(eventId: string): Promise<EventContext | null> {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      name: true, startDate: true, endDate: true,
      venue: true, city: true, country: true,
      cmeHours: true, settings: true,
      organization: { select: { name: true, logo: true } },
    },
  });
  if (!event) return null;
  const settings = event.settings && typeof event.settings === "object" && !Array.isArray(event.settings)
    ? (event.settings as Record<string, unknown>) : {};
  const cme = settings.cme && typeof settings.cme === "object" && !Array.isArray(settings.cme)
    ? settings.cme as Record<string, unknown> : {};
  const accreditations = (cme.accreditations as AccreditationEntry[]) ?? [];
  return {
    name: event.name,
    startDate: event.startDate,
    endDate: event.endDate,
    venue: event.venue,
    city: event.city,
    country: event.country,
    organizationName: event.organization.name,
    organizationLogo: event.organization.logo,
    cmeHours: event.cmeHours == null ? null : Number(event.cmeHours),
    accreditations,
    settings: event.settings,
  };
}

function readTemplateForType(settings: unknown, type: CertificateType): CertificateTemplate {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const obj = settings as Record<string, unknown>;
  const templates = obj.certificateTemplates;
  if (templates && typeof templates === "object" && !Array.isArray(templates)) {
    const t = (templates as Record<string, unknown>)[type];
    if (t && typeof t === "object" && !Array.isArray(t)) return t as CertificateTemplate;
  }
  // Backward compat with the singular shape.
  const legacy = obj.certificateTemplate;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    return legacy as CertificateTemplate;
  }
  return {};
}

async function loadRecipient(
  registrationId: string | null,
  speakerId: string | null,
): Promise<CertificateData["recipient"] | null> {
  if (registrationId) {
    const reg = await db.registration.findUnique({
      where: { id: registrationId },
      select: {
        attendee: {
          select: { title: true, firstName: true, lastName: true, email: true,
            organization: true, jobTitle: true, city: true, country: true },
        },
      },
    });
    const a = reg?.attendee;
    if (!a) return null;
    return {
      title: a.title,
      firstName: a.firstName,
      lastName: a.lastName,
      fullName: formatRecipientName(a.title, a.firstName, a.lastName),
      organization: a.organization,
      jobTitle: a.jobTitle,
      city: a.city,
      country: a.country,
    };
  }
  if (speakerId) {
    const s = await db.speaker.findUnique({
      where: { id: speakerId },
      select: {
        title: true, firstName: true, lastName: true, email: true,
        organization: true, jobTitle: true, city: true, country: true,
      },
    });
    if (!s) return null;
    return {
      title: s.title,
      firstName: s.firstName,
      lastName: s.lastName,
      fullName: formatRecipientName(s.title, s.firstName, s.lastName),
      organization: s.organization,
      jobTitle: s.jobTitle,
      city: s.city,
      country: s.country,
    };
  }
  return null;
}

function formatRecipientName(title: string | null, first: string, last: string): string {
  const map: Record<string, string> = { DR: "Dr.", MR: "Mr.", MRS: "Mrs.", MS: "Ms.", PROF: "Prof." };
  const t = title ? `${map[title] ?? ""} ` : "";
  return `${t}${first} ${last}`.trim();
}

async function allocateSerial(eventId: string, type: CertificateType): Promise<string> {
  const counter = await db.certificateSerialCounter.upsert({
    where: { eventId_type: { eventId, type } },
    create: { eventId, type, lastSerial: 1 },
    update: { lastSerial: { increment: 1 } },
    select: { lastSerial: true },
  });
  const code = await db.event.findUnique({ where: { id: eventId }, select: { code: true } });
  const prefix = code?.code ?? eventId.slice(0, 6).toUpperCase();
  return `${prefix}-${type.slice(0, 3)}-${String(counter.lastSerial).padStart(4, "0")}`;
}

async function loadPosterAbstractTitle(speakerId: string, eventId: string): Promise<string | null> {
  const abstract = await db.abstract.findFirst({
    where: { eventId, presentationType: "POSTER", status: "ACCEPTED", speakerId },
    select: { title: true },
    orderBy: { createdAt: "asc" },
  });
  return abstract?.title ?? null;
}

async function getRunTriggerUserId(runId: string): Promise<string> {
  const run = await db.certificateIssueRun.findUnique({
    where: { id: runId },
    select: { triggeredByUserId: true },
  });
  if (!run) throw new Error(`Run ${runId} not found while resolving triggeredByUserId`);
  return run.triggeredByUserId;
}

async function loadPdfBytes(pdfUrl: string): Promise<Buffer> {
  if (pdfUrl.startsWith("/uploads/")) {
    // Local — read directly from public/ on disk.
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    return readFile(join(process.cwd(), "public", pdfUrl));
  }
  // Supabase or absolute URL — fetch.
  const res = await fetch(pdfUrl);
  if (!res.ok) throw new Error(`Failed to fetch PDF: HTTP ${res.status} ${pdfUrl}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

async function markItemFailed(
  runId: string,
  itemId: string,
  phase: "render" | "email",
  message: string,
) {
  await db.certificateIssueRunItem.update({
    where: { id: itemId },
    data: { errorPhase: phase, errorMessage: message.slice(0, 1000) },
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
