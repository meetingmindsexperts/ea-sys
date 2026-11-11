/**
 * THE rule for who receives a certificate (Nov 11, 2026): the people ASSIGNED
 * it, one CertificateAssignment row per person per template.
 *
 * Every door asks here: the Issue tab (eligibility.ts), the bulk email
 * (bulk-issue.ts), the person's own card (deliver.ts), the survey auto-issue
 * sweep (auto-issue.ts) and the agent. Writes go through
 * src/services/certificate-assignment-service.ts.
 *
 * It replaced a free-text tag (CertificateTemplate.autoIssueTag matched
 * against Attendee.tags / Speaker.tags). Never match a tag to decide who
 * receives a certificate again: the word had to be spelled the same in two
 * places, it said nothing about who added it or when, and it lived on the
 * attendee, not on the registration.
 *
 * Routing is unchanged from the tag days. An ATTENDANCE template goes to a
 * registration, an APPRECIATION template to a speaker, and one person can be
 * both (a speaker with a companion registration), so a person has two facets
 * and each is asked separately.
 *
 * A row is a decision, not a delivery. Whether the certificate exists and was
 * sent is read from IssuedCertificate and the run items (recipients-report.ts).
 */

import type { CertificateType, Prisma } from "@prisma/client";

/** `db` or a transaction: both satisfy it. */
type Client = Prisma.TransactionClient;

/**
 * How an assignment came to be. Stored as a plain string so a new source
 * never needs a migration.
 *  - MANUAL: picked on the Recipients tab, or on the Registrations or Speakers page
 *  - EMAIL_LIST: matched from a pasted list of addresses
 *  - AGENT: added through the agent / MCP tools
 *  - TAG_BACKFILL: copied from the old tag by the migration
 *  - ISSUED_BACKFILL: the person already held the certificate at the migration
 */
export const CERTIFICATE_ASSIGNMENT_SOURCES = [
  "MANUAL",
  "EMAIL_LIST",
  "AGENT",
  "TAG_BACKFILL",
  "ISSUED_BACKFILL",
] as const;
export type CertificateAssignmentSource = (typeof CERTIFICATE_ASSIGNMENT_SOURCES)[number];

/** What a staff screen calls each source. */
export const CERTIFICATE_ASSIGNMENT_SOURCE_LABELS: Record<CertificateAssignmentSource, string> = {
  MANUAL: "Assigned by hand",
  EMAIL_LIST: "From a list of emails",
  AGENT: "By the AI agent",
  TAG_BACKFILL: "Carried over from a tag",
  ISSUED_BACKFILL: "Already held the certificate",
};

export function assignmentSourceLabel(source: string): string {
  return CERTIFICATE_ASSIGNMENT_SOURCE_LABELS[source as CertificateAssignmentSource] ?? source;
}

/**
 * Most people one call may assign or remove: larger than any event's audience
 * so far. Here, not in the service, so the Recipients tab can tell someone
 * their selection is too large before sending it.
 */
export const MAX_ASSIGNMENT_BATCH = 5000;

/** The facet a template's category is assigned to and issued against. */
export function recipientKindFor(category: CertificateType): "registration" | "speaker" {
  return category === "ATTENDANCE" ? "registration" : "speaker";
}

export interface AssignableTemplate {
  id: string;
  category: CertificateType;
}

export interface AssignedTarget {
  templateId: string;
  category: CertificateType;
  recipient: "registration" | "speaker";
}

/**
 * Which of `templates` a person receives, given the template ids assigned to
 * each of their facets. Pure, no database.
 *
 * `speakerTemplateIds` is null when the person has no speaker record: an
 * APPRECIATION template then matches nothing, whatever is assigned elsewhere.
 * A template nobody was assigned matches nobody. There is deliberately no
 * "everyone" case: a certificate is never issued to a person nobody chose.
 */
export function selectAssignedTargets(
  templates: readonly AssignableTemplate[],
  registrationTemplateIds: ReadonlySet<string>,
  speakerTemplateIds: ReadonlySet<string> | null,
): AssignedTarget[] {
  const targets: AssignedTarget[] = [];
  for (const t of templates) {
    if (t.category === "ATTENDANCE") {
      if (registrationTemplateIds.has(t.id)) {
        targets.push({ templateId: t.id, category: t.category, recipient: "registration" });
      }
      continue;
    }
    if (speakerTemplateIds?.has(t.id)) {
      targets.push({ templateId: t.id, category: t.category, recipient: "speaker" });
    }
  }
  return targets;
}

export interface AssignedTemplateIds {
  /** Templates assigned to the registration facet. */
  registration: Set<string>;
  /** Templates assigned to the speaker facet; null when there is no speaker. */
  speaker: Set<string> | null;
}

/**
 * The templates among `templateIds` assigned to a person's two facets, in one
 * query. Either id may be null (a registrant who is not a speaker, a speaker
 * who never registered).
 */
export async function loadAssignedTemplateIds(
  client: Client,
  input: { templateIds: readonly string[]; registrationId: string | null; speakerId: string | null },
): Promise<AssignedTemplateIds> {
  const result: AssignedTemplateIds = {
    registration: new Set<string>(),
    speaker: input.speakerId ? new Set<string>() : null,
  };
  if (input.templateIds.length === 0) return result;
  const facets: Prisma.CertificateAssignmentWhereInput[] = [];
  if (input.registrationId) facets.push({ registrationId: input.registrationId });
  if (input.speakerId) facets.push({ speakerId: input.speakerId });
  if (facets.length === 0) return result;

  const rows = await client.certificateAssignment.findMany({
    where: { certificateTemplateId: { in: [...input.templateIds] }, OR: facets },
    select: { certificateTemplateId: true, registrationId: true, speakerId: true },
  });
  for (const row of rows) {
    if (row.registrationId && row.registrationId === input.registrationId) {
      result.registration.add(row.certificateTemplateId);
    }
    if (row.speakerId && row.speakerId === input.speakerId) {
      result.speaker?.add(row.certificateTemplateId);
    }
  }
  return result;
}

/**
 * The registrations assigned a template that may still receive it: a
 * cancelled registration keeps its row and is left out by every reader, so
 * reinstating it restores what it had.
 */
export function assignedRegistrationWhere(templateId: string): Prisma.RegistrationWhereInput {
  return {
    status: { not: "CANCELLED" },
    certificateAssignments: { some: { certificateTemplateId: templateId } },
  };
}

/** The speakers assigned a template. */
export function assignedSpeakerWhere(templateId: string): Prisma.SpeakerWhereInput {
  return { certificateAssignments: { some: { certificateTemplateId: templateId } } };
}

/** An assignment that still counts: a speaker's, or a registration's that is not cancelled. */
export const LIVE_ASSIGNMENT_WHERE = {
  OR: [{ speakerId: { not: null } }, { registration: { status: { not: "CANCELLED" } } }],
} satisfies Prisma.CertificateAssignmentWhereInput;

/** How many people each template is assigned to (cancelled registrations left out). */
export async function countAssignmentsByTemplate(
  client: Client,
  templateIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(templateIds.map((id) => [id, 0]));
  if (templateIds.length === 0) return counts;
  const rows = await client.certificateAssignment.groupBy({
    by: ["certificateTemplateId"],
    where: { certificateTemplateId: { in: [...templateIds] }, ...LIVE_ASSIGNMENT_WHERE },
    _count: { _all: true },
  });
  for (const row of rows) counts.set(row.certificateTemplateId, row._count._all);
  return counts;
}

/**
 * One lock per event for the three writers that together decide whether a
 * person who answered the survey is owed a certificate automatically:
 *
 *   1. the survey auto-issue sweep (reads the switch and the assignments,
 *      then stamps the registration as checked),
 *   2. assigning a certificate (adds a row, then re-opens the registration),
 *   3. turning a template's auto-issue switch on (re-opens everyone assigned).
 *
 * Without it they race at READ COMMITTED: the sweep reads "not assigned", an
 * assignment commits and re-opens a registration that is not stamped yet, and
 * the sweep then stamps it. The person is assigned, has answered, and nothing
 * ever looks at them again. Each writer takes this lock as the FIRST statement
 * of its transaction and reads what it decides on AFTER it, so whichever goes
 * second sees the first one's work.
 *
 * A transaction-scoped advisory lock (the registration-email-lock pattern):
 * released at commit or rollback, safe behind the pooler.
 */
export async function lockCertificateAssignments(tx: Client, eventId: string): Promise<void> {
  // ::text because pg_advisory_xact_lock returns void, which $queryRaw cannot read.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${certificateAssignmentLockKey(eventId)}))::text`;
}

export function certificateAssignmentLockKey(eventId: string): string {
  return `certificate-assignment:${eventId}`;
}
