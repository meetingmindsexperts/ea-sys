/**
 * Shared activity-timeline builder for a person in an event — works from
 * EITHER anchor (a Speaker or a Registration) and folds in the linked
 * counterpart, so someone who is BOTH a speaker and a registrant sees ONE
 * consistent feed from either page.
 *
 * Sources merged (newest-first), each tagged with its origin entity:
 *   • AuditLog        (entityType "Speaker" / "Registration")
 *   • EmailLog        (entityType "SPEAKER" / "REGISTRATION")
 *   • IssuedCertificate (linked via speakerId / registrationId) — with the
 *     pdfUrl so the UI can open/preview it.
 *
 * Counterpart resolution (pointed, never duplicated):
 *   • speaker → registration:  Speaker.sourceRegistrationId, else a
 *     Registration in the event whose Attendee.email == speaker email.
 *   • registration → speaker:  a Speaker with sourceRegistrationId == this
 *     registration, else a Speaker in the event with the same email.
 * Independent / manually-added speakers (no registration) just get the
 * speaker-only feed.
 */
import { db } from "@/lib/db";
import { getEmailLogsFor } from "@/lib/email-log";

export type ActivitySource = "speaker" | "registration";

export interface ActivityItem {
  id: string;
  source: ActivitySource;
  kind: "audit" | "email" | "certificate";
  at: string; // ISO
  // audit
  action?: string;
  actor?: string | null;
  ipAddress?: string | null;
  // email
  subject?: string;
  to?: string;
  status?: string;
  templateSlug?: string | null;
  errorMessage?: string | null;
  // certificate
  serial?: string;
  certType?: string;
  pdfUrl?: string | null;
  revoked?: boolean;
}

export interface ActivityFeed {
  items: ActivityItem[];
  /** The linked counterpart entity, when one was resolved. */
  linked: { type: ActivitySource; id: string; linkedBy: "pointer" | "email" } | null;
}

const AUDIT_SELECT = {
  id: true,
  action: true,
  ipAddress: true,
  createdAt: true,
  user: { select: { firstName: true, lastName: true } },
} as const;

function actorLabel(user: { firstName: string | null; lastName: string | null } | null): string | null {
  if (!user) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

/** Collect + map activity for whichever of the two entities are present. */
async function collect(
  speakerId: string | null,
  registrationId: string | null,
  organizationId: string | null | undefined,
): Promise<ActivityItem[]> {
  const items: ActivityItem[] = [];

  const [spkAudit, spkEmail, spkCerts, regAudit, regEmail, regCerts] = await Promise.all([
    speakerId
      ? db.auditLog.findMany({
          where: { entityType: "Speaker", entityId: speakerId },
          orderBy: { createdAt: "desc" },
          take: 100,
          select: AUDIT_SELECT,
        })
      : Promise.resolve([]),
    speakerId ? getEmailLogsFor("SPEAKER", speakerId, organizationId) : Promise.resolve([]),
    speakerId
      ? db.issuedCertificate.findMany({
          where: { speakerId },
          orderBy: { issuedAt: "desc" },
          select: { id: true, serial: true, type: true, issuedAt: true, revokedAt: true, pdfUrl: true },
        })
      : Promise.resolve([]),
    registrationId
      ? db.auditLog.findMany({
          where: { entityType: "Registration", entityId: registrationId },
          orderBy: { createdAt: "desc" },
          take: 100,
          select: AUDIT_SELECT,
        })
      : Promise.resolve([]),
    registrationId ? getEmailLogsFor("REGISTRATION", registrationId, organizationId) : Promise.resolve([]),
    registrationId
      ? db.issuedCertificate.findMany({
          where: { registrationId },
          orderBy: { issuedAt: "desc" },
          select: { id: true, serial: true, type: true, issuedAt: true, revokedAt: true, pdfUrl: true },
        })
      : Promise.resolve([]),
  ]);

  type AuditRow = (typeof spkAudit)[number];
  type EmailRow = (typeof spkEmail)[number];
  type CertRow = (typeof spkCerts)[number];

  const pushAudit = (rows: AuditRow[], source: ActivitySource) => {
    for (const r of rows) {
      items.push({
        id: `audit:${r.id}`,
        source,
        kind: "audit",
        at: r.createdAt.toISOString(),
        action: r.action,
        actor: actorLabel(r.user),
        ipAddress: r.ipAddress,
      });
    }
  };
  const pushEmail = (rows: EmailRow[], source: ActivitySource) => {
    for (const r of rows) {
      items.push({
        id: `email:${r.id}`,
        source,
        kind: "email",
        at: r.createdAt.toISOString(),
        subject: r.subject,
        to: r.to,
        status: r.status,
        templateSlug: r.templateSlug,
        errorMessage: r.errorMessage,
      });
    }
  };
  const pushCerts = (rows: CertRow[], source: ActivitySource) => {
    for (const r of rows) {
      items.push({
        id: `cert:${r.id}`,
        source,
        kind: "certificate",
        at: r.issuedAt.toISOString(),
        serial: r.serial,
        certType: r.type,
        pdfUrl: r.pdfUrl,
        revoked: r.revokedAt != null,
      });
    }
  };

  pushAudit(spkAudit, "speaker");
  pushEmail(spkEmail, "speaker");
  pushCerts(spkCerts, "speaker");
  pushAudit(regAudit, "registration");
  pushEmail(regEmail, "registration");
  pushCerts(regCerts, "registration");

  // Newest first.
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items;
}

export interface LinkedCounterpart {
  id: string;
  linkedBy: "pointer" | "email";
}

/**
 * Resolve the registration linked to a speaker — the explicit
 * `sourceRegistrationId` pointer (companion / imported-from), else a
 * read-time email match. Shared so the activity feed AND the
 * issued-certificates card agree on "the same person's" counterpart.
 */
export async function resolveLinkedRegistration(
  eventId: string,
  speaker: { sourceRegistrationId: string | null; email: string | null },
): Promise<LinkedCounterpart | null> {
  if (speaker.sourceRegistrationId) {
    return { id: speaker.sourceRegistrationId, linkedBy: "pointer" };
  }
  if (speaker.email) {
    const match = await db.registration.findFirst({
      where: { eventId, attendee: { email: speaker.email } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (match) return { id: match.id, linkedBy: "email" };
  }
  return null;
}

/** Resolve the speaker linked to a registration — pointer, else email. */
export async function resolveLinkedSpeaker(
  eventId: string,
  registration: { id: string; attendeeEmail: string | null },
): Promise<LinkedCounterpart | null> {
  const pointed = await db.speaker.findFirst({
    where: { eventId, sourceRegistrationId: registration.id },
    select: { id: true },
  });
  if (pointed) return { id: pointed.id, linkedBy: "pointer" };
  if (registration.attendeeEmail) {
    const byEmail = await db.speaker.findFirst({
      where: { eventId, email: registration.attendeeEmail },
      select: { id: true },
    });
    if (byEmail) return { id: byEmail.id, linkedBy: "email" };
  }
  return null;
}

/** Activity anchored on a speaker (+ its linked registration, if any). */
export async function buildSpeakerActivity(
  eventId: string,
  speaker: { id: string; email: string; sourceRegistrationId: string | null },
  organizationId: string | null | undefined,
): Promise<ActivityFeed> {
  const linked = await resolveLinkedRegistration(eventId, speaker);
  const items = await collect(speaker.id, linked?.id ?? null, organizationId);
  return {
    items,
    linked: linked ? { type: "registration", id: linked.id, linkedBy: linked.linkedBy } : null,
  };
}

/** Activity anchored on a registration (+ its linked speaker, if any). */
export async function buildRegistrationActivity(
  eventId: string,
  registration: { id: string; attendeeEmail: string | null },
  organizationId: string | null | undefined,
): Promise<ActivityFeed> {
  const linked = await resolveLinkedSpeaker(eventId, registration);
  const items = await collect(linked?.id ?? null, registration.id, organizationId);
  return {
    items,
    linked: linked ? { type: "speaker", id: linked.id, linkedBy: linked.linkedBy } : null,
  };
}
