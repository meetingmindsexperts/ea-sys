/**
 * Phase 2 — survey-gated certificate auto-issue.
 *
 * When a registrant completes the post-event survey, the cert worker
 * automatically issues every certificate template that is flagged
 * `autoIssueOnSurvey` AND whose `autoIssueTag` the person holds. The
 * survey POST path is UNTOUCHED — it already sets `surveyCompletedAt`.
 * This module is the worker-side sweep that drives off that flag.
 *
 * Routing (the per-category split — see SPEAKER_AS_ATTENDEE_PLAN.md
 * "Companion hardening" note C):
 *   - ATTENDANCE templates match the registration's ATTENDEE tags →
 *     cert issued to `registrationId`.
 *   - APPRECIATION templates match the linked SPEAKER's tags →
 *     cert issued to `speakerId`.
 * A speaker who completes the survey via their companion registration
 * therefore gets BOTH their attendance cert (on the companion reg) and
 * their role/appreciation cert (on the speaker).
 *
 * Delivery reuses the existing CertificateIssueRun machinery: each
 * (template, recipient) becomes a 1-item `autoIssue` run in PENDING.
 * The worker's render/email pipeline drains it; auto runs SKIP the
 * AWAITING_REVIEW gate (render → SENDING) so the cert lands in the
 * inbox without an operator click (confirmed product decision).
 *
 * Idempotency: per-template IssuedCertificate uniqueness + a pre-create
 * guard (skip if a cert OR an existing auto-run item already covers the
 * (event, template, recipient)) make re-sweeps and crash-retries safe —
 * no duplicate certs, no double emails.
 *
 * Retry + backoff: a per-registration transient failure increments
 * `certAutoIssueAttempts`, records the error, and defers the row via
 * `certAutoIssueNextAttemptAt = now + backoff` (exponential) so it
 * never head-of-line-blocks the queue. After MAX_AUTO_ISSUE_ATTEMPTS it
 * gives up terminally (the manual Issue flow is the backstop). Every
 * sweep emits a structured `cert-auto-issue:sweep` analytics line.
 */

import type { CertificateType } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

// Process up to this many candidate registrations per sweep tick. The
// cert-issue job runs every 3 min and shares the worker connection pool,
// so we keep the batch modest — each registration does a few queries.
const SWEEP_BATCH_SIZE = 50;

// Give up after this many failed attempts (manual Issue is the backstop).
const MAX_AUTO_ISSUE_ATTEMPTS = 5;

// Exponential backoff in minutes, indexed by attempt number (1-based):
// 1m, 5m, 15m, 60m, 180m. Past the array length we clamp to the last.
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];

function backoffMs(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[idx] * 60_000;
}

const TITLE_MAP: Record<string, string> = {
  DR: "Dr.",
  MR: "Mr.",
  MRS: "Mrs.",
  MS: "Ms.",
  PROF: "Prof.",
};

function formatName(opts: {
  title?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string {
  const tprefix = opts.title ? `${TITLE_MAP[opts.title] ?? ""} ` : "";
  const full = `${tprefix}${opts.firstName ?? ""} ${opts.lastName ?? ""}`.trim();
  return full || "(unnamed)";
}

// ── Pure target-selection (constraint C routing) — unit-tested ────────────────

export interface AutoIssueTemplate {
  id: string;
  category: CertificateType; // ATTENDANCE | APPRECIATION
  autoIssueTag: string | null;
  emailSubject: string | null;
  emailBody: string | null;
}

export interface AutoIssueTarget {
  templateId: string;
  category: CertificateType;
  recipient: "registration" | "speaker";
}

/**
 * Decide which templates fire for a survey-completer, routed per category.
 * Pure — no DB. ATTENDANCE matches the attendee's tags (→ registration);
 * APPRECIATION matches the linked speaker's tags (→ speaker), and only
 * when a speaker exists. A template with no `autoIssueTag` never matches
 * (we refuse to mass-issue to everyone who surveyed — a tag is required).
 */
export function selectAutoIssueTargets(
  templates: AutoIssueTemplate[],
  attendeeTags: string[],
  speakerTags: string[] | null,
): AutoIssueTarget[] {
  const targets: AutoIssueTarget[] = [];
  for (const t of templates) {
    const tag = t.autoIssueTag?.trim();
    if (!tag) continue; // no tag → nothing to match against
    if (t.category === "ATTENDANCE") {
      if (attendeeTags.includes(tag)) {
        targets.push({ templateId: t.id, category: t.category, recipient: "registration" });
      }
    } else {
      // APPRECIATION
      if (speakerTags && speakerTags.includes(tag)) {
        targets.push({ templateId: t.id, category: t.category, recipient: "speaker" });
      }
    }
  }
  return targets;
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

export interface AutoIssueSweepResult {
  scanned: number;
  resolved: number; // registrations terminally checked this tick (success)
  runsCreated: number; // auto-runs enqueued this tick
  deferred: number; // registrations that hit a transient error → backoff
  gaveUp: number; // registrations that exhausted retries this tick
  skippedNoTemplates: number; // events with no auto-issue templates configured
}

/**
 * One sweep tick. Pulls candidate registrations (survey-completed, not
 * terminally checked, past their backoff gate), resolves + enqueues their
 * auto-issue certs, and advances retry/backoff state. Returns analytics
 * counts for the structured worker log. Failure-isolated per registration.
 */
export async function runAutoIssueSweep(
  opts: { batchSize?: number; now?: Date } = {},
): Promise<AutoIssueSweepResult> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? SWEEP_BATCH_SIZE;

  const candidates = await db.registration.findMany({
    where: {
      surveyCompletedAt: { not: null },
      certAutoIssueCheckedAt: null,
      OR: [
        { certAutoIssueNextAttemptAt: null },
        { certAutoIssueNextAttemptAt: { lte: now } },
      ],
    },
    take: batchSize,
    orderBy: { surveyCompletedAt: "asc" },
    select: {
      id: true,
      eventId: true,
      certAutoIssueAttempts: true,
      attendee: {
        select: { title: true, firstName: true, lastName: true, email: true, tags: true },
      },
    },
  });

  const result: AutoIssueSweepResult = {
    scanned: candidates.length,
    resolved: 0,
    runsCreated: 0,
    deferred: 0,
    gaveUp: 0,
    skippedNoTemplates: 0,
  };
  if (candidates.length === 0) return result;

  // Load each event's auto-issue templates once (the batch may span events).
  const templatesByEvent = new Map<string, AutoIssueTemplate[]>();
  for (const eventId of new Set(candidates.map((c) => c.eventId))) {
    const templates = await db.certificateTemplate.findMany({
      where: { eventId, autoIssueOnSurvey: true },
      select: { id: true, category: true, autoIssueTag: true, emailSubject: true, emailBody: true },
    });
    templatesByEvent.set(eventId, templates);
    // Surface a misconfiguration: auto-issue ON but no tag → nothing matches.
    const taglessCount = templates.filter((t) => !t.autoIssueTag?.trim()).length;
    if (taglessCount > 0) {
      apiLogger.warn({
        msg: "cert-auto-issue:template-missing-tag",
        eventId,
        taglessCount,
        hint: "autoIssueOnSurvey is enabled but autoIssueTag is empty — these templates will never match anyone.",
      });
    }
  }

  for (const reg of candidates) {
    const templates = templatesByEvent.get(reg.eventId) ?? [];
    if (templates.length === 0) {
      // No auto-issue templates for this event — terminally resolve so the
      // row isn't re-scanned every tick. Manual Issue covers later configs.
      await db.registration
        .update({ where: { id: reg.id }, data: { certAutoIssueCheckedAt: now } })
        .catch((err) =>
          apiLogger.warn({ err, msg: "cert-auto-issue:stamp-failed", registrationId: reg.id }),
        );
      result.skippedNoTemplates++;
      result.resolved++;
      continue;
    }

    try {
      const created = await processRegistration(reg, templates, now);
      result.runsCreated += created;
      result.resolved++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nextAttempt = reg.certAutoIssueAttempts + 1;
      const giveUp = nextAttempt >= MAX_AUTO_ISSUE_ATTEMPTS;
      // Defer (or give up) — never block the queue on a poison row.
      await db.registration
        .update({
          where: { id: reg.id },
          data: {
            certAutoIssueAttempts: nextAttempt,
            certAutoIssueError: message.slice(0, 1000),
            ...(giveUp
              ? { certAutoIssueCheckedAt: now, certAutoIssueNextAttemptAt: null }
              : { certAutoIssueNextAttemptAt: new Date(now.getTime() + backoffMs(nextAttempt)) }),
          },
        })
        .catch((e) =>
          apiLogger.error({ err: e, msg: "cert-auto-issue:defer-update-failed", registrationId: reg.id }),
        );
      if (giveUp) {
        result.gaveUp++;
        apiLogger.error({
          msg: "cert-auto-issue:gave-up",
          registrationId: reg.id,
          eventId: reg.eventId,
          attempts: nextAttempt,
          error: message,
        });
      } else {
        result.deferred++;
        apiLogger.warn({
          msg: "cert-auto-issue:deferred",
          registrationId: reg.id,
          eventId: reg.eventId,
          attempt: nextAttempt,
          nextAttemptInMinutes: Math.round(backoffMs(nextAttempt) / 60_000),
          error: message,
        });
      }
    }
  }

  apiLogger.info({ msg: "cert-auto-issue:sweep", ...result });
  return result;
}

/**
 * Resolve + enqueue one registration's auto-issue certs in a single
 * transaction (atomic with the terminal stamp, so a crash mid-way rolls
 * back cleanly and the row retries from scratch). Returns the count of
 * auto-runs created. Throws on failure so the caller applies backoff.
 */
async function processRegistration(
  reg: {
    id: string;
    eventId: string;
    attendee: {
      title: string | null;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      tags: string[];
    } | null;
  },
  templates: AutoIssueTemplate[],
  now: Date,
): Promise<number> {
  const attendeeTags = reg.attendee?.tags ?? [];

  // Resolve the linked speaker for APPRECIATION routing: the companion
  // case (Speaker.sourceRegistrationId == this reg) first, else a
  // read-time email match (a speaker who registered separately).
  let speaker = await db.speaker.findFirst({
    where: { sourceRegistrationId: reg.id },
    select: { id: true, title: true, firstName: true, lastName: true, email: true, tags: true },
  });
  if (!speaker && reg.attendee?.email) {
    speaker = await db.speaker.findFirst({
      where: { eventId: reg.eventId, email: reg.attendee.email },
      select: { id: true, title: true, firstName: true, lastName: true, email: true, tags: true },
    });
  }

  const targets = selectAutoIssueTargets(templates, attendeeTags, speaker?.tags ?? null);
  const templateMap = new Map(templates.map((t) => [t.id, t]));

  let created = 0;
  await db.$transaction(async (tx) => {
    // Idempotency guards run per target FIRST — a target is dropped when a
    // cert already exists OR an auto-run item already covers this
    // (event, template, recipient). The bundle-aware item check matches
    // both legacy 1-template runs (certificateTemplateId) and bundle runs
    // (templateIds has).
    const surviving: typeof targets = [];
    for (const target of targets) {
      if (!templateMap.has(target.templateId)) continue;
      const isSpeakerRecipient = target.recipient === "speaker";
      const recipientWhere = isSpeakerRecipient
        ? { speakerId: speaker!.id }
        : { registrationId: reg.id };
      const existingCert = await tx.issuedCertificate.findFirst({
        where: { eventId: reg.eventId, certificateTemplateId: target.templateId, ...recipientWhere },
        select: { id: true },
      });
      if (existingCert) continue;
      const existingItem = await tx.certificateIssueRunItem.findFirst({
        where: {
          run: {
            eventId: reg.eventId,
            autoIssue: true,
            OR: [
              { certificateTemplateId: target.templateId },
              { templateIds: { has: target.templateId } },
            ],
          },
          ...recipientWhere,
        },
        select: { id: true },
      });
      if (existingItem) continue;
      surviving.push(target);
    }

    if (surviving.length > 0) {
      // ONE run + ONE person-keyed item covering the person's whole
      // surviving target set → ONE email with every earned PDF attached
      // (a committee+speaker person no longer gets two emails).
      const templateIds = surviving.map((t) => t.templateId);
      const anySpeakerTarget = surviving.some((t) => t.recipient === "speaker");
      const anyRegistrationTarget = surviving.some((t) => t.recipient === "registration");
      const runType = anyRegistrationTarget ? "ATTENDANCE" : "APPRECIATION";
      // Cover email: a single template keeps its own saved cover email
      // (today's behavior); a multi bundle leaves the snapshot null so the
      // send phase falls back to the MULTI defaults ({{certificateList}}).
      const single = surviving.length === 1 ? templateMap.get(surviving[0].templateId) : null;
      if (!single && surviving.length > 1) {
        apiLogger.info({
          msg: "cert-auto-issue:multi-default-cover",
          registrationId: reg.id,
          eventId: reg.eventId,
          templateIds,
        });
      }
      // Name/email anchor: prefer the attendee (registration facet), else
      // the speaker — matches how the render phase resolves recipients.
      const recipientName = anyRegistrationTarget
        ? formatName(reg.attendee ?? {})
        : formatName(speaker!);
      const recipientEmail = anyRegistrationTarget
        ? reg.attendee?.email ?? null
        : speaker!.email;

      const run = await tx.certificateIssueRun.create({
        data: {
          eventId: reg.eventId,
          type: runType,
          certificateTemplateId: surviving.length === 1 ? surviving[0].templateId : null,
          templateIds,
          autoIssue: true,
          triggeredByUserId: null,
          status: "PENDING",
          totalCount: 1,
          emailSubject: single?.emailSubject ?? null,
          emailBody: single?.emailBody ?? null,
          notes: "Auto-issued on survey completion",
        },
        select: { id: true },
      });
      await tx.certificateIssueRunItem.create({
        data: {
          runId: run.id,
          registrationId: anyRegistrationTarget ? reg.id : null,
          speakerId: anySpeakerTarget ? speaker!.id : null,
          recipientName,
          recipientEmail,
          // The stamped subset the render phase issues (bundle model).
          templateIds,
        },
      });
      created = surviving.length;
    }

    // Terminal stamp — clears any prior error + attempts now that we've
    // resolved cleanly.
    await tx.registration.update({
      where: { id: reg.id },
      data: { certAutoIssueCheckedAt: now, certAutoIssueError: null },
    });
  });

  return created;
}
