/**
 * The certificate recipients report (Nov 11, 2026): for one event, every
 * person assigned a certificate and where they stand, on one row. Who is
 * assigned what, whether they answered the certificate survey, and whether
 * the certificate exists and was sent.
 *
 * This is the report the tag model could not produce: a tag said nothing
 * about who added it, when, or what happened next.
 *
 * Read-only, and it stores nothing. Each fact comes from the table that owns
 * it:
 *   assigned          CertificateAssignment (./assignments.ts)
 *   survey answered   Registration.surveyCompletedAt (the certificate survey)
 *   certificate       IssuedCertificate
 *   sent              isReleased (registrant-certificates.ts), the same rule
 *                     that decides what a person sees on their own portal, so
 *                     "Sent" here is what they can download there
 *
 * A speaker's survey is read through their registration at the event (the
 * companion pointer, else the same address), the way the survey sweep reaches
 * them.
 */

import type { CertificateType } from "@prisma/client";
import { db } from "@/lib/db";
import { isReleased, RELEASE_FIELDS, resolveCmeHours, type EmailedRunItem } from "@/lib/registrant-certificates";
import { localDateInTz, resolveTimezone } from "@/lib/event-time";
import { getTitleLabel } from "@/lib/utils";
import { assignmentSourceLabel } from "./assignments";
import { RECIPIENT_STATES, RECIPIENT_STATE_LABELS, recipientState, type RecipientState } from "./recipient-states";

export {
  RECIPIENT_STATES,
  RECIPIENT_STATE_LABELS,
  RECIPIENT_STATE_HINTS,
  recipientState,
  type RecipientState,
  type RecipientStateFacts,
} from "./recipient-states";

export interface RecipientReportRow {
  assignmentId: string;
  templateId: string;
  templateName: string;
  category: CertificateType;
  kind: "registration" | "speaker";
  registrationId: string | null;
  speakerId: string | null;
  name: string;
  email: string | null;
  /** The registration type, for a registration. */
  registrationType: string | null;
  source: string;
  assignedAt: Date;
  assignedByName: string | null;
  surveyAnsweredAt: Date | null;
  state: RecipientState;
  /** Hours the certificate carries: the issued one's, else what the template would give. */
  cmeHours: string | null;
  certificate: { id: string; serial: string; issuedAt: Date } | null;
}

export interface RecipientReportTemplate {
  id: string;
  name: string;
  category: CertificateType;
  autoIssueOnSurvey: boolean;
  /** Rows on the report for this template. */
  assigned: number;
  counts: Record<RecipientState, number>;
}

export interface AnsweredNotAssigned {
  registrationId: string;
  name: string;
  email: string | null;
  registrationType: string | null;
  surveyAnsweredAt: Date;
}

export interface RecipientReport {
  /** The event's timezone: dates on the report and its export are the event's days. */
  timezone: string;
  templates: RecipientReportTemplate[];
  rows: RecipientReportRow[];
  /** Answered the certificate survey, not cancelled, and assigned no
   *  certificate at all, on the registration or on its linked speaker (the
   *  companion pointer or the same address, the sweep's two links): the
   *  people a tag used to lose silently. */
  answeredNotAssigned: AnsweredNotAssigned[];
}

function personName(p: { title?: string | null; firstName?: string | null; lastName?: string | null }): string {
  const title = p.title ? getTitleLabel(p.title) : "";
  return [title, p.firstName, p.lastName].filter(Boolean).join(" ").trim() || "(unnamed)";
}

function emptyCounts(): Record<RecipientState, number> {
  return Object.fromEntries(RECIPIENT_STATES.map((s) => [s, 0])) as Record<RecipientState, number>;
}

const RUN_IN_FLIGHT = ["PENDING", "RENDERING", "AWAITING_REVIEW", "SENDING"] as const;

interface SurveyFacts {
  surveyAnsweredAt: Date | null;
  sweepChecked: boolean;
  sweepFailed: boolean;
}

const NO_SURVEY: SurveyFacts = { surveyAnsweredAt: null, sweepChecked: false, sweepFailed: false };

function surveyFactsOf(r: {
  surveyCompletedAt: Date | null;
  certAutoIssueCheckedAt: Date | null;
  certAutoIssueError: string | null;
}): SurveyFacts {
  return {
    surveyAnsweredAt: r.surveyCompletedAt,
    sweepChecked: r.certAutoIssueCheckedAt !== null,
    sweepFailed: r.certAutoIssueCheckedAt !== null && r.certAutoIssueError !== null,
  };
}

/** The event facts the report needs. The caller has already loaded the event
 *  through its access check, so the report does not read it again. */
export interface RecipientReportEvent {
  id: string;
  timezone: string | null;
  cmeHours: { toString(): string } | null;
}

/**
 * The report for one event, optionally for one template. Call inside the
 * event's tenant lane (the route does), as every certificate read.
 */
export async function loadRecipientReport(
  event: RecipientReportEvent,
  opts: { templateId?: string } = {},
): Promise<RecipientReport> {
  const eventId = event.id;
  const templateFilter = opts.templateId ? { certificateTemplateId: opts.templateId } : {};

  const [templates, assignments, certificates, emailedItems, flightItems, answeredUnassigned, assignedSpeakers] = await Promise.all([
    db.certificateTemplate.findMany({
      where: { eventId, ...(opts.templateId ? { id: opts.templateId } : {}) },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, category: true, autoIssueOnSurvey: true, cmeHours: true },
    }),
    db.certificateAssignment.findMany({
      where: { eventId, ...templateFilter },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        certificateTemplateId: true,
        registrationId: true,
        speakerId: true,
        source: true,
        createdAt: true,
        assignedBy: { select: { firstName: true, lastName: true } },
        registration: {
          select: {
            status: true,
            surveyCompletedAt: true,
            certAutoIssueCheckedAt: true,
            certAutoIssueError: true,
            ticketType: { select: { name: true } },
            attendee: { select: { title: true, firstName: true, lastName: true, email: true } },
          },
        },
        speaker: {
          select: { title: true, firstName: true, lastName: true, email: true, sourceRegistrationId: true },
        },
      },
    }),
    db.issuedCertificate.findMany({
      where: { eventId, certificateTemplateId: opts.templateId ?? { not: null } },
      orderBy: { issuedAt: "desc" },
      select: {
        id: true,
        serial: true,
        issuedAt: true,
        revokedAt: true,
        cmeHoursSnapshot: true,
        ...RELEASE_FIELDS,
      },
    }),
    db.certificateIssueRunItem.findMany({
      where: { emailedAt: { not: null }, run: { eventId } },
      select: {
        registrationId: true,
        speakerId: true,
        templateIds: true,
        run: { select: { eventId: true, certificateTemplateId: true } },
      },
    }),
    db.certificateIssueRunItem.findMany({
      where: { errorPhase: null, run: { eventId, status: { in: [...RUN_IN_FLIGHT] } } },
      select: {
        registrationId: true,
        speakerId: true,
        templateIds: true,
        run: { select: { certificateTemplateId: true, templateIds: true } },
      },
    }),
    db.registration.findMany({
      where: {
        eventId,
        surveyCompletedAt: { not: null },
        status: { not: "CANCELLED" },
        certificateAssignments: { none: {} },
      },
      orderBy: { surveyCompletedAt: "asc" },
      select: {
        id: true,
        surveyCompletedAt: true,
        ticketType: { select: { name: true } },
        attendee: { select: { title: true, firstName: true, lastName: true, email: true } },
      },
    }),
    // Speakers assigned any certificate: their registration is not "on no
    // list", the sweep reaches them through it (review of 631e95bd).
    db.speaker.findMany({
      where: { eventId, certificateAssignments: { some: {} } },
      select: { email: true, sourceRegistrationId: true },
    }),
  ]);
  const speakerRegistrationIds = new Set(assignedSpeakers.flatMap((s) => (s.sourceRegistrationId ? [s.sourceRegistrationId] : [])));
  const speakerEmails = new Set(assignedSpeakers.flatMap((s) => (s.email ? [s.email] : [])));
  const answeredNotAssigned = answeredUnassigned.filter(
    (r) => !speakerRegistrationIds.has(r.id) && !(r.attendee.email && speakerEmails.has(r.attendee.email)),
  );

  // A speaker's survey facts, through their registration at the event.
  const speakerRows = assignments.flatMap((a) => (a.speaker && a.speakerId ? [{ id: a.speakerId, ...a.speaker }] : []));
  const surveyBySpeaker = await loadSpeakerSurveyFacts(eventId, speakerRows);

  // The newest certificate per (template, person): a revoked one is only
  // shown when nothing newer replaced it.
  const certByKey = new Map<string, (typeof certificates)[number]>();
  for (const cert of certificates) {
    const person = cert.registrationId ?? cert.speakerId;
    if (!cert.certificateTemplateId || !person) continue;
    const key = `${cert.certificateTemplateId}:${person}`;
    const held = certByKey.get(key);
    if (!held || (held.revokedAt && !cert.revokedAt)) certByKey.set(key, cert);
  }

  const inFlight = new Set<string>();
  for (const item of flightItems) {
    const person = item.registrationId ?? item.speakerId;
    const ids = item.templateIds.length > 0 ? item.templateIds : runTemplateIds(item.run);
    if (!person) continue;
    for (const id of ids) inFlight.add(`${id}:${person}`);
    // A bundle item carries both facets: the speaker's certificate is in flight too.
    if (item.registrationId && item.speakerId) for (const id of ids) inFlight.add(`${id}:${item.speakerId}`);
  }

  const templateById = new Map(templates.map((t) => [t.id, t]));
  const summary = new Map<string, RecipientReportTemplate>(
    templates.map((t) => [
      t.id,
      { id: t.id, name: t.name, category: t.category, autoIssueOnSurvey: t.autoIssueOnSurvey, assigned: 0, counts: emptyCounts() },
    ]),
  );

  const rows: RecipientReportRow[] = [];
  for (const a of assignments) {
    const template = templateById.get(a.certificateTemplateId);
    const person = a.registrationId ?? a.speakerId;
    if (!template || !person) continue;
    const facet = a.registration?.attendee ?? a.speaker;
    if (!facet) continue;

    const survey = a.registration
      ? surveyFactsOf(a.registration)
      : (surveyBySpeaker.get(person) ?? NO_SURVEY);
    const cert = certByKey.get(`${template.id}:${person}`) ?? null;
    const state = recipientState({
      registrationCancelled: a.registration?.status === "CANCELLED",
      certificate: cert ? { revoked: cert.revokedAt !== null, released: isReleased(cert, emailedItems as EmailedRunItem[]) } : null,
      autoIssueOnSurvey: template.autoIssueOnSurvey,
      surveyAnswered: survey.surveyAnsweredAt !== null,
      sweepChecked: survey.sweepChecked,
      sweepFailed: survey.sweepFailed,
      inRun: inFlight.has(`${template.id}:${person}`),
    });

    rows.push({
      assignmentId: a.id,
      templateId: template.id,
      templateName: template.name,
      category: template.category,
      kind: a.registrationId ? "registration" : "speaker",
      registrationId: a.registrationId,
      speakerId: a.speakerId,
      name: personName(facet),
      email: facet.email ?? null,
      registrationType: a.registration?.ticketType?.name ?? null,
      source: a.source,
      assignedAt: a.createdAt,
      assignedByName: a.assignedBy ? personName(a.assignedBy) : null,
      surveyAnsweredAt: survey.surveyAnsweredAt,
      state,
      cmeHours: resolveCmeHours(cert?.cmeHoursSnapshot, template.cmeHours, event.cmeHours),
      certificate: cert ? { id: cert.id, serial: cert.serial, issuedAt: cert.issuedAt } : null,
    });
    const s = summary.get(template.id);
    if (s) {
      s.assigned++;
      s.counts[state]++;
    }
  }

  return {
    timezone: resolveTimezone(event.timezone),
    templates: [...summary.values()],
    rows,
    answeredNotAssigned: answeredNotAssigned.map((r) => ({
      registrationId: r.id,
      name: personName(r.attendee),
      email: r.attendee.email ?? null,
      registrationType: r.ticketType?.name ?? null,
      surveyAnsweredAt: r.surveyCompletedAt!,
    })),
  };
}

function runTemplateIds(run: { certificateTemplateId: string | null; templateIds: string[] }): string[] {
  if (run.templateIds.length > 0) return run.templateIds;
  return run.certificateTemplateId ? [run.certificateTemplateId] : [];
}

/**
 * Each speaker's survey facts, read off the registration the sweep would
 * reach them through: the companion pointer first, else a registration at the
 * event on the same address. One that has answered wins over one that has not.
 */
async function loadSpeakerSurveyFacts(
  eventId: string,
  speakers: ReadonlyArray<{ id: string; email: string | null; sourceRegistrationId: string | null }>,
): Promise<Map<string, SurveyFacts>> {
  const facts = new Map<string, SurveyFacts>();
  if (speakers.length === 0) return facts;
  const pointerIds = speakers.flatMap((s) => (s.sourceRegistrationId ? [s.sourceRegistrationId] : []));
  const emails = [...new Set(speakers.flatMap((s) => (s.email ? [s.email] : [])))];
  if (pointerIds.length === 0 && emails.length === 0) return facts;

  const registrations = await db.registration.findMany({
    where: {
      eventId,
      status: { not: "CANCELLED" },
      OR: [{ id: { in: pointerIds } }, { attendee: { email: { in: emails } } }],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      surveyCompletedAt: true,
      certAutoIssueCheckedAt: true,
      certAutoIssueError: true,
      attendee: { select: { email: true } },
    },
  });
  for (const s of speakers) {
    const linked = registrations.filter(
      (r) => r.id === s.sourceRegistrationId || (!!s.email && r.attendee.email === s.email),
    );
    const pick = linked.find((r) => r.surveyCompletedAt !== null) ?? linked[0];
    if (pick) facts.set(s.id, surveyFactsOf(pick));
  }
  return facts;
}

/** The CSV the report exports: one line per assigned person per certificate. */
export const RECIPIENT_REPORT_HEADERS = [
  "Certificate",
  "Kind",
  "Name",
  "Email",
  "Registration type",
  "Status",
  "Survey answered",
  "Certificate number",
  "Issued on",
  "CME hours",
  "Assigned on",
  "Assigned by",
  "How assigned",
] as const;

/** The report as CSV cells, header first. Dates are the event's own days. */
export function recipientReportCsv(report: RecipientReport): string[][] {
  const day = (d: Date | null) => (d ? localDateInTz(d, report.timezone) : "");
  return [
    [...RECIPIENT_REPORT_HEADERS],
    ...report.rows.map((r) => [
      r.templateName,
      r.category === "ATTENDANCE" ? "Attendance" : "Appreciation",
      r.name,
      r.email ?? "",
      r.registrationType ?? "",
      RECIPIENT_STATE_LABELS[r.state],
      day(r.surveyAnsweredAt),
      r.certificate?.serial ?? "",
      day(r.certificate?.issuedAt ?? null),
      r.cmeHours ?? "",
      day(r.assignedAt),
      r.assignedByName ?? "",
      assignmentSourceLabel(r.source),
    ]),
  ];
}
