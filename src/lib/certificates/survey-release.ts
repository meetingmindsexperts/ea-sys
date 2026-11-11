/**
 * What the survey auto-issue sweep would send each registration, decided ONCE
 * (Nov 11, 2026, review of 631e95bd).
 *
 * Two callers ask it, inside the per-event lock (lockCertificateAssignments):
 *
 *   - the sweep (auto-issue.ts), to queue the certificates, and
 *   - assigning a certificate and turning a template's switch on
 *     (certificate-assignment-service.ts), to COUNT what re-opening those
 *     registrations would send, before asking the person to confirm.
 *
 * They used to work it out separately. The service counted only the template
 * being assigned, and the sweep then sent EVERY auto-issue certificate the
 * person was owed. So someone assigned "CME Day 1" before the deploy, who had
 * answered, also got Day 1 when staff assigned Day 2 and confirmed "1
 * certificate". One function means the number shown is the number sent.
 *
 * The plan for a registration is the auto-issue templates assigned to it (an
 * ATTENDANCE template on the registration, an APPRECIATION one on its linked
 * speaker), minus any it already holds (revoked counts as held) and any a
 * run that has not finished is already sending. It does not look at whether
 * the person answered or at the "checked" stamp: callers decide who to ask.
 */

import type { CertificateType, Prisma } from "@prisma/client";
import { selectAssignedTargets, type AssignedTarget } from "./assignments";

type Tx = Prisma.TransactionClient;

/** Runs that will still email what they cover. FAILED / CANCELLED will not; COMPLETED already did. */
export const LIVE_RUN_STATUSES = ["PENDING", "RENDERING", "AWAITING_REVIEW", "SENDING"] as const;

/**
 * A run item that is still going to email this template: its run has not
 * finished and the item did not fail to render. The Issue tab leaves such
 * people out, as the sweep does, or a run created while the sweep's is in
 * flight emails the same certificate twice.
 */
export function liveRunItemFor(templateId: string): Prisma.CertificateIssueRunItemWhereInput {
  return {
    errorPhase: null,
    run: {
      status: { in: [...LIVE_RUN_STATUSES] },
      OR: [{ certificateTemplateId: templateId }, { templateIds: { has: templateId } }],
    },
  };
}

export interface PlannedSpeaker {
  id: string;
  title: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
}

export interface PlannedRelease {
  registrationId: string;
  /** The speaker an APPRECIATION certificate goes to, when there is one. */
  speaker: PlannedSpeaker | null;
  /** What the sweep sends this registration now. Empty: nothing. */
  targets: AssignedTarget[];
}

export interface SurveyReleasePlan {
  /** The event's auto-issue templates, so a caller can tell "none switched on" from "none owed". */
  autoIssueTemplates: Array<{ id: string; name: string; category: CertificateType }>;
  byRegistration: Map<string, PlannedRelease>;
}

const SPEAKER_SELECT = { id: true, title: true, firstName: true, lastName: true, email: true, sourceRegistrationId: true, createdAt: true } as const;

/**
 * The speaker the sweep routes a registration's APPRECIATION certificates to:
 * the companion (Speaker.sourceRegistrationId) first, else the earliest
 * speaker at the event on exactly the same address.
 */
async function linkedSpeakers(
  tx: Tx,
  eventId: string,
  registrations: ReadonlyArray<{ id: string; email: string | null }>,
): Promise<Map<string, PlannedSpeaker>> {
  const ids = registrations.map((r) => r.id);
  const emails = [...new Set(registrations.flatMap((r) => (r.email ? [r.email] : [])))];
  const speakers = await tx.speaker.findMany({
    where: {
      eventId,
      OR: [{ sourceRegistrationId: { in: ids } }, ...(emails.length > 0 ? [{ email: { in: emails } }] : [])],
    },
    select: SPEAKER_SELECT,
    orderBy: { createdAt: "asc" },
  });
  const byPointer = new Map<string, PlannedSpeaker>();
  const byEmail = new Map<string, PlannedSpeaker>();
  for (const s of speakers) {
    const facts: PlannedSpeaker = { id: s.id, title: s.title, firstName: s.firstName, lastName: s.lastName, email: s.email };
    if (s.sourceRegistrationId && !byPointer.has(s.sourceRegistrationId)) byPointer.set(s.sourceRegistrationId, facts);
    if (s.email && !byEmail.has(s.email)) byEmail.set(s.email, facts);
  }
  const result = new Map<string, PlannedSpeaker>();
  for (const r of registrations) {
    const speaker = byPointer.get(r.id) ?? (r.email ? byEmail.get(r.email) : undefined);
    if (speaker) result.set(r.id, speaker);
  }
  return result;
}

/** "template id|recipient id" for a set of covered pairs. */
function pairKey(templateId: string, recipientId: string): string {
  return `${templateId}|${recipientId}`;
}

export async function planSurveyReleases(
  tx: Tx,
  eventId: string,
  registrationIds: readonly string[],
): Promise<SurveyReleasePlan> {
  const autoIssueTemplates = await tx.certificateTemplate.findMany({
    where: { eventId, autoIssueOnSurvey: true },
    select: { id: true, name: true, category: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const byRegistration = new Map<string, PlannedRelease>();
  const ids = [...new Set(registrationIds)];
  if (ids.length === 0) return { autoIssueTemplates, byRegistration };
  if (autoIssueTemplates.length === 0) {
    for (const id of ids) byRegistration.set(id, { registrationId: id, speaker: null, targets: [] });
    return { autoIssueTemplates, byRegistration };
  }

  const registrations = await tx.registration.findMany({
    where: { id: { in: ids }, eventId },
    select: { id: true, attendee: { select: { email: true } } },
  });
  const speakerByRegistration = await linkedSpeakers(
    tx,
    eventId,
    registrations.map((r) => ({ id: r.id, email: r.attendee?.email ?? null })),
  );
  const speakerIds = [...new Set([...speakerByRegistration.values()].map((s) => s.id))];
  const templateIds = autoIssueTemplates.map((t) => t.id);
  const facets: Prisma.CertificateAssignmentWhereInput[] = [{ registrationId: { in: ids } }];
  if (speakerIds.length > 0) facets.push({ speakerId: { in: speakerIds } });
  const recipients = speakerIds.length > 0
    ? [{ registrationId: { in: ids } }, { speakerId: { in: speakerIds } }]
    : [{ registrationId: { in: ids } }];

  const [assignments, held, inFlight] = await Promise.all([
    tx.certificateAssignment.findMany({
      where: { certificateTemplateId: { in: templateIds }, OR: facets },
      select: { certificateTemplateId: true, registrationId: true, speakerId: true },
    }),
    tx.issuedCertificate.findMany({
      where: { eventId, certificateTemplateId: { in: templateIds }, OR: recipients },
      select: { certificateTemplateId: true, registrationId: true, speakerId: true },
    }),
    tx.certificateIssueRunItem.findMany({
      where: {
        errorPhase: null,
        run: { eventId, status: { in: [...LIVE_RUN_STATUSES] } },
        OR: recipients,
      },
      select: {
        registrationId: true,
        speakerId: true,
        run: { select: { certificateTemplateId: true, templateIds: true } },
      },
    }),
  ]);

  const assignedToRegistration = new Map<string, Set<string>>();
  const assignedToSpeaker = new Map<string, Set<string>>();
  for (const a of assignments) {
    const map = a.registrationId ? assignedToRegistration : assignedToSpeaker;
    const key = a.registrationId ?? a.speakerId;
    if (!key) continue;
    const set = map.get(key) ?? new Set<string>();
    set.add(a.certificateTemplateId);
    map.set(key, set);
  }
  // Pairs that must not be queued again: held, or covered by a live run.
  const covered = new Set<string>();
  for (const h of held) {
    const recipientId = h.registrationId ?? h.speakerId;
    if (recipientId && h.certificateTemplateId) covered.add(pairKey(h.certificateTemplateId, recipientId));
  }
  for (const item of inFlight) {
    const runTemplates = new Set(item.run.templateIds);
    if (item.run.certificateTemplateId) runTemplates.add(item.run.certificateTemplateId);
    for (const templateId of runTemplates) {
      if (item.registrationId) covered.add(pairKey(templateId, item.registrationId));
      if (item.speakerId) covered.add(pairKey(templateId, item.speakerId));
    }
  }

  for (const r of registrations) {
    const speaker = speakerByRegistration.get(r.id) ?? null;
    const targets = selectAssignedTargets(
      autoIssueTemplates,
      assignedToRegistration.get(r.id) ?? new Set<string>(),
      speaker ? (assignedToSpeaker.get(speaker.id) ?? new Set<string>()) : null,
    ).filter((t) => !covered.has(pairKey(t.templateId, t.recipient === "speaker" ? speaker!.id : r.id)));
    byRegistration.set(r.id, { registrationId: r.id, speaker, targets });
  }
  return { autoIssueTemplates, byRegistration };
}

export interface ReleaseSummary {
  /** Certificates the next sweep sends. */
  certificates: number;
  /** People they go to (one email each). */
  people: number;
  /** Per template, largest first. */
  byTemplate: Array<{ templateId: string; templateName: string; count: number }>;
  /** The registrations to hand back to the sweep: only those with something to send. */
  registrationIds: string[];
}

/**
 * Add up a plan. Several registrations can reach the same speaker (a
 * companion and a second registration on the same address); a speaker's
 * certificate is counted once, as the sweep's guard sends it once.
 */
export function summarizeRelease(plan: SurveyReleasePlan): ReleaseSummary {
  const names = new Map(plan.autoIssueTemplates.map((t) => [t.id, t.name]));
  const counted = new Set<string>();
  const perTemplate = new Map<string, number>();
  const registrationIds: string[] = [];
  for (const release of plan.byRegistration.values()) {
    let any = false;
    for (const t of release.targets) {
      const recipientId = t.recipient === "speaker" ? release.speaker!.id : release.registrationId;
      const key = pairKey(t.templateId, recipientId);
      if (counted.has(key)) continue;
      counted.add(key);
      perTemplate.set(t.templateId, (perTemplate.get(t.templateId) ?? 0) + 1);
      any = true;
    }
    if (any) registrationIds.push(release.registrationId);
  }
  const byTemplate = [...perTemplate.entries()]
    .map(([templateId, count]) => ({ templateId, templateName: names.get(templateId) ?? templateId, count }))
    .sort((a, b) => b.count - a.count || a.templateName.localeCompare(b.templateName));
  return {
    certificates: counted.size,
    people: registrationIds.length,
    byTemplate,
    registrationIds,
  };
}
