/**
 * Certificate assignments: the writes behind "who receives this certificate"
 * (Nov 11, 2026). The rule itself, and every reader, is in
 * src/lib/certificates/assignments.ts.
 *
 * Three operations, called by the REST routes and the agent / MCP tools:
 *
 *   assignCertificate      add people to a template's list
 *   unassignCertificate    take people off it (never someone who holds it)
 *   setTemplateAutoIssue   the template's "send when the survey is answered" switch
 *
 * THE CONFIRMATION (owner, Nov 11, 2026). Survey auto-issue sends with no
 * review step. Since assignments, order no longer matters: a certificate is
 * owed once a person is assigned AND has answered, whichever happens last. So
 * two actions can release a batch at once: assigning people who have already
 * answered, and turning the switch on for a template whose people have
 * already answered. Both refuse with CONFIRM_SEND_NOW, carrying the number of
 * certificates that would go out, until the caller passes `confirmSendNow`.
 * It is enforced here, not in a dialog, so no door can skip it.
 *
 * Each operation takes the per-event lock (lockCertificateAssignments) as its
 * first statement and reads what it decides on after it; see that function
 * for the race it closes against the survey sweep.
 */

import type { CertificateType, Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  LIVE_ASSIGNMENT_WHERE,
  lockCertificateAssignments,
  recipientKindFor,
  type CertificateAssignmentSource,
} from "@/lib/certificates/assignments";

type Tx = Prisma.TransactionClient;
type CallerSource = "rest" | "mcp" | "agent" | "api";

/** Most people one call may assign or remove: larger than any event's audience so far. */
export const MAX_ASSIGNMENT_BATCH = 5000;

/** Audit rows name the people touched, up to this many ids. */
const AUDIT_ID_CAP = 200;

interface TemplateFacts {
  id: string;
  eventId: string;
  name: string;
  category: CertificateType;
  autoIssueOnSurvey: boolean;
}

function loadTemplate(tx: Tx, eventId: string, templateId: string): Promise<TemplateFacts | null> {
  return tx.certificateTemplate.findFirst({
    where: { id: templateId, eventId },
    select: { id: true, eventId: true, name: true, category: true, autoIssueOnSurvey: true },
  });
}

// ── Who has answered ─────────────────────────────────────────────────────────

/** A registration the survey sweep would look at: answered, and not cancelled. */
const ANSWERED_WHERE = {
  surveyCompletedAt: { not: null },
  status: { not: "CANCELLED" },
} satisfies Prisma.RegistrationWhereInput;

/**
 * For each speaker, the registrations the survey sweep would reach them
 * through: the companion pointer (Speaker.sourceRegistrationId), or a
 * registration at the event on the same address. The sweep walks the other
 * way (registration to speaker) with the same two links, so this is the set
 * that can carry an appreciation certificate to that speaker.
 */
async function answeredRegistrationsBySpeaker(
  tx: Tx,
  eventId: string,
  speakerIds: readonly string[],
): Promise<Map<string, string[]>> {
  const bySpeaker = new Map<string, string[]>();
  if (speakerIds.length === 0) return bySpeaker;
  const speakers = await tx.speaker.findMany({
    where: { id: { in: [...speakerIds] }, eventId },
    select: { id: true, email: true, sourceRegistrationId: true },
  });
  const pointerIds = speakers.flatMap((s) => (s.sourceRegistrationId ? [s.sourceRegistrationId] : []));
  const emails = [...new Set(speakers.flatMap((s) => (s.email ? [s.email] : [])))];
  if (pointerIds.length === 0 && emails.length === 0) return bySpeaker;

  const registrations = await tx.registration.findMany({
    where: {
      eventId,
      ...ANSWERED_WHERE,
      OR: [{ id: { in: pointerIds } }, { attendee: { email: { in: emails } } }],
    },
    select: { id: true, attendee: { select: { email: true } } },
  });
  for (const s of speakers) {
    const linked = registrations
      .filter((r) => r.id === s.sourceRegistrationId || (!!s.email && r.attendee.email === s.email))
      .map((r) => r.id);
    if (linked.length > 0) bySpeaker.set(s.id, linked);
  }
  return bySpeaker;
}

interface SendNow {
  /** People whose certificate the next sweep will send. */
  count: number;
  /** Their registrations, to re-open for that sweep. */
  registrationIds: string[];
}

/**
 * Among these people, who has already answered the survey and does not hold
 * this template's certificate: the ones the sweep will send to as soon as it
 * looks at them again. Holding a certificate counts even when revoked, as it
 * does in the sweep's own guard.
 */
async function findSendNow(
  tx: Tx,
  template: TemplateFacts,
  ids: { registrationIds: readonly string[]; speakerIds: readonly string[] },
): Promise<SendNow> {
  if (recipientKindFor(template.category) === "registration") {
    if (ids.registrationIds.length === 0) return { count: 0, registrationIds: [] };
    const rows = await tx.registration.findMany({
      where: {
        id: { in: [...ids.registrationIds] },
        eventId: template.eventId,
        ...ANSWERED_WHERE,
        issuedCertificates: { none: { certificateTemplateId: template.id } },
      },
      select: { id: true },
    });
    return { count: rows.length, registrationIds: rows.map((r) => r.id) };
  }

  const linked = await answeredRegistrationsBySpeaker(tx, template.eventId, ids.speakerIds);
  if (linked.size === 0) return { count: 0, registrationIds: [] };
  const holders = await tx.issuedCertificate.findMany({
    where: { certificateTemplateId: template.id, speakerId: { in: [...linked.keys()] } },
    select: { speakerId: true },
  });
  const holding = new Set(holders.map((h) => h.speakerId));
  const owed = [...linked.entries()].filter(([speakerId]) => !holding.has(speakerId));
  return {
    count: owed.length,
    registrationIds: [...new Set(owed.flatMap(([, registrationIds]) => registrationIds))],
  };
}

/**
 * Hand registrations back to the survey sweep: clear the "checked" stamp and
 * the retry state so the next tick looks at them again. Only ones that have
 * answered; the sweep does not look at the others until they do.
 */
async function reopenForSweep(tx: Tx, registrationIds: readonly string[]): Promise<number> {
  if (registrationIds.length === 0) return 0;
  const res = await tx.registration.updateMany({
    where: { id: { in: [...registrationIds] }, ...ANSWERED_WHERE },
    data: {
      certAutoIssueCheckedAt: null,
      certAutoIssueAttempts: 0,
      certAutoIssueNextAttemptAt: null,
      certAutoIssueError: null,
    },
  });
  return res.count;
}

function writeAudit(args: {
  eventId: string;
  userId: string | null;
  action: string;
  templateId: string;
  changes: Prisma.InputJsonObject;
}): void {
  db.auditLog
    .create({
      data: {
        eventId: args.eventId,
        userId: args.userId,
        action: args.action,
        entityType: "CertificateTemplate",
        entityId: args.templateId,
        changes: args.changes,
      },
    })
    .catch((err) =>
      apiLogger.warn({ err, msg: "cert-assignment:audit-failed", eventId: args.eventId, templateId: args.templateId, action: args.action }),
    );
}

// ── Assign ───────────────────────────────────────────────────────────────────

export interface AssignCertificateInput {
  eventId: string;
  /** The event's organisation, stamped on each row (tenancy). */
  organizationId: string | null;
  templateId: string;
  /** For an attendance template. */
  registrationIds?: readonly string[];
  /** For an appreciation template. */
  speakerIds?: readonly string[];
  userId: string | null;
  source: CallerSource;
  assignmentSource: CertificateAssignmentSource;
  /** The caller has been shown how many certificates go out at once and agreed. */
  confirmSendNow: boolean;
  /** Work everything out and write nothing: the preview behind a confirm step. */
  dryRun?: boolean;
}

export type AssignCertificateErrorCode =
  | "TEMPLATE_NOT_FOUND"
  | "WRONG_RECIPIENT_TYPE"
  | "NO_RECIPIENTS"
  | "TOO_MANY"
  | "CONFIRM_SEND_NOW";

export type AssignCertificateResult =
  | {
      ok: true;
      templateName: string;
      /** People newly put on the list (on a dry run: who would be). */
      assigned: number;
      /** Already on the list: left as they were. */
      alreadyAssigned: number;
      /** Ids that are not this event's, or a cancelled registration. */
      skipped: number;
      /** Of `assigned`, the certificates the survey sweep sends straight away. */
      sendNow: number;
      dryRun: boolean;
    }
  | { ok: false; code: AssignCertificateErrorCode; message: string; meta?: Record<string, unknown> };

export async function assignCertificate(input: AssignCertificateInput): Promise<AssignCertificateResult> {
  const registrationIds = [...new Set(input.registrationIds ?? [])];
  const speakerIds = [...new Set(input.speakerIds ?? [])];
  const requested = registrationIds.length + speakerIds.length;
  if (requested === 0) {
    return { ok: false, code: "NO_RECIPIENTS", message: "Choose at least one person to assign." };
  }
  if (requested > MAX_ASSIGNMENT_BATCH) {
    return {
      ok: false,
      code: "TOO_MANY",
      message: `At most ${MAX_ASSIGNMENT_BATCH} people can be assigned at once.`,
      meta: { requested, max: MAX_ASSIGNMENT_BATCH },
    };
  }

  const outcome = await tenantTransaction(async (tx): Promise<AssignCertificateResult & { newIds?: string[] }> => {
    await lockCertificateAssignments(tx, input.eventId);
    const template = await loadTemplate(tx, input.eventId, input.templateId);
    if (!template) {
      return { ok: false, code: "TEMPLATE_NOT_FOUND", message: "Certificate template not found." };
    }
    const kind = recipientKindFor(template.category);
    const wrongIds = kind === "registration" ? speakerIds : registrationIds;
    const rightIds = kind === "registration" ? registrationIds : speakerIds;
    if (wrongIds.length > 0 || rightIds.length === 0) {
      return {
        ok: false,
        code: "WRONG_RECIPIENT_TYPE",
        message:
          kind === "registration"
            ? `"${template.name}" is an attendance certificate: it is assigned to registrations.`
            : `"${template.name}" is an appreciation certificate: it is assigned to speakers.`,
      };
    }

    // Only this event's people, and never a cancelled registration.
    const valid =
      kind === "registration"
        ? await tx.registration.findMany({
            where: { id: { in: rightIds }, eventId: input.eventId, status: { not: "CANCELLED" } },
            select: { id: true },
          })
        : await tx.speaker.findMany({
            where: { id: { in: rightIds }, eventId: input.eventId },
            select: { id: true },
          });
    const validIds = valid.map((v) => v.id);
    const existing = await tx.certificateAssignment.findMany({
      where: {
        certificateTemplateId: template.id,
        ...(kind === "registration" ? { registrationId: { in: validIds } } : { speakerId: { in: validIds } }),
      },
      select: { registrationId: true, speakerId: true },
    });
    const already = new Set(existing.map((e) => (kind === "registration" ? e.registrationId : e.speakerId)));
    const newIds = validIds.filter((id) => !already.has(id));

    const sendNow: SendNow = template.autoIssueOnSurvey
      ? await findSendNow(tx, template, {
          registrationIds: kind === "registration" ? newIds : [],
          speakerIds: kind === "speaker" ? newIds : [],
        })
      : { count: 0, registrationIds: [] };

    const summary = {
      ok: true as const,
      templateName: template.name,
      assigned: newIds.length,
      alreadyAssigned: already.size,
      skipped: rightIds.length - validIds.length,
      sendNow: sendNow.count,
      dryRun: input.dryRun === true,
    };
    if (input.dryRun) return summary;

    if (sendNow.count > 0 && !input.confirmSendNow) {
      return {
        ok: false,
        code: "CONFIRM_SEND_NOW",
        message: `${sendNow.count} of these people have already answered the survey. Their certificate${sendNow.count === 1 ? "" : "s"} will be sent now.`,
        meta: { sendNow: sendNow.count, assigned: newIds.length, templateName: template.name },
      };
    }
    if (newIds.length === 0) return summary;

    await tx.certificateAssignment.createMany({
      data: newIds.map((id) => ({
        eventId: input.eventId,
        organizationId: input.organizationId,
        certificateTemplateId: template.id,
        registrationId: kind === "registration" ? id : null,
        speakerId: kind === "speaker" ? id : null,
        source: input.assignmentSource,
        assignedByUserId: input.userId,
      })),
      skipDuplicates: true,
    });
    await reopenForSweep(tx, sendNow.registrationIds);
    return { ...summary, newIds };
  });

  if (!outcome.ok) {
    apiLogger.warn({
      msg: "cert-assignment:assign-rejected",
      code: outcome.code,
      eventId: input.eventId,
      templateId: input.templateId,
      userId: input.userId,
      source: input.source,
      requested,
      ...(outcome.meta ?? {}),
    });
    return outcome;
  }
  const { newIds, ...result } = outcome;
  if (result.dryRun || !newIds?.length) return result;

  writeAudit({
    eventId: input.eventId,
    userId: input.userId,
    action: "CERTIFICATE_ASSIGNED",
    templateId: input.templateId,
    changes: {
      source: input.source,
      assignmentSource: input.assignmentSource,
      templateName: result.templateName,
      assigned: result.assigned,
      sendNow: result.sendNow,
      ...(registrationIds.length > 0
        ? { registrationIds: newIds.slice(0, AUDIT_ID_CAP) }
        : { speakerIds: newIds.slice(0, AUDIT_ID_CAP) }),
    },
  });
  apiLogger.info({
    msg: "cert-assignment:assigned",
    eventId: input.eventId,
    templateId: input.templateId,
    userId: input.userId,
    source: input.source,
    assignmentSource: input.assignmentSource,
    assigned: result.assigned,
    alreadyAssigned: result.alreadyAssigned,
    skipped: result.skipped,
    sendNow: result.sendNow,
  });
  return result;
}

// ── Unassign ─────────────────────────────────────────────────────────────────

export interface UnassignCertificateInput {
  eventId: string;
  templateId: string;
  registrationIds?: readonly string[];
  speakerIds?: readonly string[];
  userId: string | null;
  source: CallerSource;
}

export type UnassignCertificateResult =
  | {
      ok: true;
      templateName: string;
      removed: number;
      /** Left on the list because they hold the certificate: revoke it instead. */
      keptIssued: number;
    }
  | { ok: false; code: "TEMPLATE_NOT_FOUND" | "NO_RECIPIENTS" | "TOO_MANY"; message: string };

/**
 * Take people off a template's list. Someone who HOLDS the certificate stays:
 * the row is what explains the certificate on the report, and taking a
 * certificate back is revoking it, which is its own action. A certificate
 * already being rendered or sent by a run still goes out.
 */
export async function unassignCertificate(input: UnassignCertificateInput): Promise<UnassignCertificateResult> {
  const registrationIds = [...new Set(input.registrationIds ?? [])];
  const speakerIds = [...new Set(input.speakerIds ?? [])];
  const requested = registrationIds.length + speakerIds.length;
  if (requested === 0) {
    return { ok: false, code: "NO_RECIPIENTS", message: "Choose at least one person to remove." };
  }
  if (requested > MAX_ASSIGNMENT_BATCH) {
    return { ok: false, code: "TOO_MANY", message: `At most ${MAX_ASSIGNMENT_BATCH} people can be removed at once.` };
  }

  const outcome = await tenantTransaction(async (tx): Promise<UnassignCertificateResult & { removedIds?: string[] }> => {
    await lockCertificateAssignments(tx, input.eventId);
    const template = await loadTemplate(tx, input.eventId, input.templateId);
    if (!template) {
      return { ok: false, code: "TEMPLATE_NOT_FOUND", message: "Certificate template not found." };
    }
    const rows = await tx.certificateAssignment.findMany({
      where: {
        certificateTemplateId: template.id,
        OR: [{ registrationId: { in: registrationIds } }, { speakerId: { in: speakerIds } }],
      },
      select: { id: true, registrationId: true, speakerId: true },
    });
    const holders = await tx.issuedCertificate.findMany({
      where: {
        certificateTemplateId: template.id,
        revokedAt: null,
        OR: [{ registrationId: { in: registrationIds } }, { speakerId: { in: speakerIds } }],
      },
      select: { registrationId: true, speakerId: true },
    });
    const holding = new Set(holders.flatMap((h) => [h.registrationId, h.speakerId]).filter((id): id is string => !!id));
    const removable = rows.filter((r) => !holding.has((r.registrationId ?? r.speakerId)!));
    if (removable.length > 0) {
      await tx.certificateAssignment.deleteMany({ where: { id: { in: removable.map((r) => r.id) } } });
    }
    return {
      ok: true,
      templateName: template.name,
      removed: removable.length,
      keptIssued: rows.length - removable.length,
      removedIds: removable.map((r) => (r.registrationId ?? r.speakerId)!),
    };
  });

  if (!outcome.ok) {
    apiLogger.warn({
      msg: "cert-assignment:unassign-rejected",
      code: outcome.code,
      eventId: input.eventId,
      templateId: input.templateId,
      userId: input.userId,
      source: input.source,
    });
    return outcome;
  }
  const { removedIds, ...result } = outcome;
  if (!removedIds?.length) return result;

  writeAudit({
    eventId: input.eventId,
    userId: input.userId,
    action: "CERTIFICATE_UNASSIGNED",
    templateId: input.templateId,
    changes: {
      source: input.source,
      templateName: result.templateName,
      removed: result.removed,
      keptIssued: result.keptIssued,
      ...(registrationIds.length > 0
        ? { registrationIds: removedIds.slice(0, AUDIT_ID_CAP) }
        : { speakerIds: removedIds.slice(0, AUDIT_ID_CAP) }),
    },
  });
  apiLogger.info({
    msg: "cert-assignment:unassigned",
    eventId: input.eventId,
    templateId: input.templateId,
    userId: input.userId,
    source: input.source,
    removed: result.removed,
    keptIssued: result.keptIssued,
  });
  return result;
}

// ── The auto-issue switch ────────────────────────────────────────────────────

export interface SetTemplateAutoIssueInput {
  eventId: string;
  templateId: string;
  enabled: boolean;
  userId: string | null;
  source: CallerSource;
  confirmSendNow: boolean;
}

export type SetTemplateAutoIssueResult =
  | { ok: true; changed: boolean; sendNow: number }
  | { ok: false; code: "TEMPLATE_NOT_FOUND" | "CONFIRM_SEND_NOW"; message: string; meta?: Record<string, unknown> };

/**
 * Turn a template's "send when the survey is answered" switch on or off.
 * THE writer of CertificateTemplate.autoIssueOnSurvey on an existing template:
 * turning it on hands every assigned person who has already answered to the
 * next sweep, so it asks for the confirmation first (see the file header).
 */
export async function setTemplateAutoIssue(input: SetTemplateAutoIssueInput): Promise<SetTemplateAutoIssueResult> {
  const outcome = await tenantTransaction(async (tx): Promise<SetTemplateAutoIssueResult> => {
    await lockCertificateAssignments(tx, input.eventId);
    const template = await loadTemplate(tx, input.eventId, input.templateId);
    if (!template) {
      return { ok: false, code: "TEMPLATE_NOT_FOUND", message: "Certificate template not found." };
    }
    if (template.autoIssueOnSurvey === input.enabled) return { ok: true, changed: false, sendNow: 0 };
    if (!input.enabled) {
      await tx.certificateTemplate.update({ where: { id: template.id }, data: { autoIssueOnSurvey: false } });
      return { ok: true, changed: true, sendNow: 0 };
    }

    const assigned = await tx.certificateAssignment.findMany({
      where: { certificateTemplateId: template.id, ...LIVE_ASSIGNMENT_WHERE },
      select: { registrationId: true, speakerId: true },
    });
    const sendNow = await findSendNow(tx, template, {
      registrationIds: assigned.flatMap((a) => (a.registrationId ? [a.registrationId] : [])),
      speakerIds: assigned.flatMap((a) => (a.speakerId ? [a.speakerId] : [])),
    });
    if (sendNow.count > 0 && !input.confirmSendNow) {
      return {
        ok: false,
        code: "CONFIRM_SEND_NOW",
        message: `${sendNow.count} assigned ${sendNow.count === 1 ? "person has" : "people have"} already answered the survey. Their certificate${sendNow.count === 1 ? "" : "s"} will be sent now.`,
        meta: { sendNow: sendNow.count, templateName: template.name },
      };
    }
    await tx.certificateTemplate.update({ where: { id: template.id }, data: { autoIssueOnSurvey: true } });
    await reopenForSweep(tx, sendNow.registrationIds);
    return { ok: true, changed: true, sendNow: sendNow.count };
  });

  if (!outcome.ok) {
    apiLogger.warn({
      msg: "cert-assignment:auto-issue-rejected",
      code: outcome.code,
      eventId: input.eventId,
      templateId: input.templateId,
      userId: input.userId,
      source: input.source,
      ...(outcome.meta ?? {}),
    });
    return outcome;
  }
  if (!outcome.changed) return outcome;

  writeAudit({
    eventId: input.eventId,
    userId: input.userId,
    action: input.enabled ? "CERTIFICATE_AUTO_ISSUE_ON" : "CERTIFICATE_AUTO_ISSUE_OFF",
    templateId: input.templateId,
    changes: { source: input.source, sendNow: outcome.sendNow },
  });
  apiLogger.info({
    msg: "cert-assignment:auto-issue-set",
    eventId: input.eventId,
    templateId: input.templateId,
    userId: input.userId,
    source: input.source,
    enabled: input.enabled,
    sendNow: outcome.sendNow,
  });
  return outcome;
}

// ── A pasted list of emails ──────────────────────────────────────────────────

export interface ResolvedEmailList {
  registrationIds: string[];
  speakerIds: string[];
  /** Addresses nobody at the event has. */
  unmatched: string[];
  /** Addresses whose only registration here is cancelled. */
  cancelled: string[];
}

/**
 * Turn a list of addresses (an attendance export from the webinar platform)
 * into this event's registrations, or speakers for an appreciation template.
 * Matched whatever the case. An address with several registrations resolves to
 * the earliest one that is not cancelled, the same pick the speaker link makes.
 */
export async function resolveAssignmentEmails(input: {
  eventId: string;
  category: CertificateType;
  emails: readonly string[];
}): Promise<ResolvedEmailList> {
  const wanted = [...new Set(input.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const result: ResolvedEmailList = { registrationIds: [], speakerIds: [], unmatched: [], cancelled: [] };
  if (wanted.length === 0) return result;

  if (recipientKindFor(input.category) === "speaker") {
    const speakers = await db.speaker.findMany({
      where: { eventId: input.eventId },
      select: { id: true, email: true },
      orderBy: { createdAt: "asc" },
    });
    const byEmail = new Map<string, string>();
    for (const s of speakers) {
      const key = s.email?.trim().toLowerCase();
      if (key && !byEmail.has(key)) byEmail.set(key, s.id);
    }
    for (const email of wanted) {
      const id = byEmail.get(email);
      if (id) result.speakerIds.push(id);
      else result.unmatched.push(email);
    }
    return result;
  }

  const registrations = await db.registration.findMany({
    where: { eventId: input.eventId },
    select: { id: true, status: true, attendee: { select: { email: true } } },
    orderBy: { createdAt: "asc" },
  });
  const live = new Map<string, string>();
  const cancelledOnly = new Set<string>();
  for (const r of registrations) {
    const key = r.attendee.email?.trim().toLowerCase();
    if (!key) continue;
    if (r.status === "CANCELLED") {
      cancelledOnly.add(key);
      continue;
    }
    if (!live.has(key)) live.set(key, r.id);
  }
  for (const email of wanted) {
    const id = live.get(email);
    if (id) result.registrationIds.push(id);
    else if (cancelledOnly.has(email)) result.cancelled.push(email);
    else result.unmatched.push(email);
  }
  return result;
}
